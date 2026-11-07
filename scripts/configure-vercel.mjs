#!/usr/bin/env node
/** Node 24: node --use-env-proxy scripts/configure-vercel.mjs [--apply] [--deploy] [--create] [--sync-public-env] */
import { execFileSync } from "node:child_process";

const apply = process.argv.includes("--apply");
const deploy = process.argv.includes("--deploy");
const create = process.argv.includes("--create");
const syncPublicEnv = process.argv.includes("--sync-public-env");
const name = process.env.VERCEL_PROJECT_NAME || "genaides-prompt-chain-tool";
const repository =
  process.env.GITHUB_REPOSITORY || "Joceyu1/genAIDes-Prompt-Chain-Tool";
const scope = process.env.VERCEL_SCOPE || "jocelyn13";
let teamId;
let scopedProject;
if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(name))
  throw new Error("Invalid VERCEL_PROJECT_NAME.");
if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
  throw new Error("Invalid GITHUB_REPOSITORY.");
if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(scope))
  throw new Error("Invalid VERCEL_SCOPE.");
if (!apply) {
  console.log(
    `Dry run: use ${scope}/${name} for ${repository}, and disable deployment protection.`,
  );
  console.log(
    create
      ? "Explicit --create permits project creation if it is missing in this exact scope."
      : "The existing project is required; no project will be created.",
  );
  if (syncPublicEnv)
    console.log(
      "Will sync only the Supabase public URL and anon/publishable key to Production and Preview. AI keys are never copied.",
    );
  console.log(
    "No changes made. Use --apply after supplying VERCEL_TOKEN securely. Add --deploy only when the code, production variables, and database migration are ready.",
  );
  process.exit(0);
}
if (!process.env.VERCEL_TOKEN)
  throw new Error(
    "VERCEL_TOKEN must be supplied through secure environment settings.",
  );

// Fixed public-only allowlist. Never accept arbitrary secret names for transfer.
const publicEnv = [];
if (syncPublicEnv) {
  const urlValue = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let publicUrl;
  try {
    publicUrl = new URL(urlValue);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a valid HTTPS URL.");
  }
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL must be an HTTPS project URL without credentials, query, or fragment.",
    );
  }
  const keyName = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ? "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
    : "NEXT_PUBLIC_SUPABASE_ANON_KEY";
  const keyValue = process.env[keyName];
  let isPublic = keyValue?.startsWith("sb_publishable_");
  if (!isPublic && keyValue?.split(".").length === 3) {
    try {
      isPublic =
        JSON.parse(
          Buffer.from(keyValue.split(".")[1], "base64url").toString("utf8"),
        ).role === "anon";
    } catch {
      isPublic = false;
    }
  }
  if (!isPublic)
    throw new Error(
      `${keyName} must be a Supabase anon/publishable key. Service-role keys, secret keys, and proxy placeholders cannot be transferred.`,
    );
  publicEnv.push(
    { key: "NEXT_PUBLIC_SUPABASE_URL", value: urlValue },
    { key: keyName, value: keyValue },
  );
}

async function api(path, method = "GET", body, unscoped = false) {
  const url = new URL(path, "https://api.vercel.com");
  if (teamId && !unscoped) url.searchParams.set("teamId", teamId);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(
      `Vercel ${method} ${url.pathname} failed (HTTP ${response.status}, code ${result.error?.code || "unknown"}).`,
    );
    error.status = response.status;
    throw error;
  }
  return result;
}

async function resolveScope() {
  // Project-scoped tokens can resolve the exact slug-qualified project without
  // requiring account-wide access to enumerate teams or personal profiles.
  try {
    const exact = await api(
      `/v9/projects/${encodeURIComponent(name)}?slug=${encodeURIComponent(scope)}`,
      "GET",
      undefined,
      true,
    );
    if (
      exact.name !== name ||
      typeof exact.accountId !== "string" ||
      !exact.accountId
    )
      throw new Error(
        "The exact-scope project response has an unexpected name or missing account ID. No project changes made.",
      );
    if (
      process.env.VERCEL_TEAM_ID &&
      exact.accountId !== process.env.VERCEL_TEAM_ID
    )
      throw new Error(
        "VERCEL_TEAM_ID does not match the exact-scope project's account ID. No project changes made.",
      );
    scopedProject = exact;
    teamId = exact.accountId.startsWith("team_") ? exact.accountId : undefined;
    return;
  } catch (error) {
    if (![403, 404].includes(error.status)) throw error;
  }
  if (process.env.VERCEL_TEAM_ID) {
    const team = await api(
      `/v2/teams/${encodeURIComponent(process.env.VERCEL_TEAM_ID)}`,
      "GET",
      undefined,
      true,
    );
    if (team.slug !== scope)
      throw new Error(
        "VERCEL_TEAM_ID does not match the requested VERCEL_SCOPE. No project changes made.",
      );
    teamId = team.id;
    return;
  }
  let until;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const result = await api(
      `/v2/teams?limit=100${until ? `&until=${encodeURIComponent(until)}` : ""}`,
      "GET",
      undefined,
      true,
    );
    const matches = result.teams.filter((team) => team.slug === scope);
    if (matches.length === 1) {
      teamId = matches[0].id;
      return;
    }
    if (matches.length > 1)
      throw new Error("Ambiguous Vercel scope. Set VERCEL_TEAM_ID explicitly.");
    until = result.pagination?.next;
    if (!until) break;
    if (seen.has(until))
      throw new Error(
        "Vercel team pagination did not advance. No project changes made.",
      );
    seen.add(until);
  }
  if (until)
    throw new Error(
      "Vercel team discovery was incomplete. Set VERCEL_TEAM_ID explicitly.",
    );
  // Prefer an exact team slug: Vercel may migrate personal projects to a
  // same-named Hobby team. A personal username is an explicit match only.
  const user = (await api("/v2/user", "GET", undefined, true)).user;
  if (user?.username === scope) return;
  throw new Error(
    `Cannot resolve accessible Vercel scope ${scope}. No project changes made.`,
  );
}

await resolveScope();
console.log(
  `Resolved the exact ${scope} scope (${teamId ? "team" : "personal account"}).`,
);
let project;
try {
  project =
    scopedProject || (await api(`/v9/projects/${encodeURIComponent(name)}`));
} catch (error) {
  if (error.status !== 404) throw error;
  if (!create)
    throw new Error(
      `The existing ${scope}/${name} project was not found. No project was created. Check access and scope.`,
    );
  project = await api("/v11/projects", "POST", {
    name,
    framework: "nextjs",
    gitRepository: { type: "github", repo: repository },
  });
  console.log(`Created project ${project.name} in ${scope}.`);
}
if (project.accountId && teamId && project.accountId !== teamId)
  throw new Error("Project owner does not match the resolved team.");

if (project.link?.type && project.link.type !== "github") {
  throw new Error(
    "Existing project is linked to another Git provider; inspect it before changing its connection.",
  );
}
if (
  project.link?.org &&
  project.link?.repo &&
  `${project.link.org}/${project.link.repo}`.toLowerCase() !==
    repository.toLowerCase()
) {
  throw new Error(
    "Existing project is linked to a different GitHub repository. No connection changes were made.",
  );
}
if (!project.link) {
  console.log(
    "Existing project has no Git connection. Connect the selected repository under Vercel Project Settings → Git before deploying.",
  );
}

if (syncPublicEnv) {
  await api(
    `/v10/projects/${encodeURIComponent(project.id)}/env?upsert=true`,
    "POST",
    publicEnv.map((entry) => ({
      ...entry,
      type: "encrypted",
      target: ["production", "preview"],
    })),
  );
  console.log(
    "Synced Supabase public configuration to Production and Preview. No AI or service-role keys were transferred.",
  );
}

if (deploy) {
  if (!project.link)
    throw new Error(
      "Connect the repository in Vercel Project Settings → Git before deploying.",
    );
  // Read encrypted metadata only; never decrypt, log, or copy credential values.
  const metadata = await api(
    `/v10/projects/${encodeURIComponent(project.id)}/env?decrypt=false`,
  );
  const productionKeys = new Set(
    metadata.envs
      .filter((entry) => {
        const targets = Array.isArray(entry.target)
          ? entry.target
          : [entry.target];
        return targets.includes("production") && !entry.gitBranch;
      })
      .map((entry) => entry.key),
  );
  const required = [
    ["NEXT_PUBLIC_SUPABASE_URL"],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"],
    ["GEMINI_API_KEY", "GOOGLE_API_KEY", "AI_API_KEY", "OPENAI_API_KEY"],
  ];
  const missing = required.filter(
    (group) => !group.some((key) => productionKeys.has(key)),
  );
  if (missing.length)
    throw new Error(
      `Missing production environment variable requirements: ${missing.map((group) => group.join(" or ")).join(", ")}. Configure them securely in Vercel.`,
    );
  if (process.env.SUPABASE_MIGRATION_APPLIED !== "1") {
    throw new Error(
      "Complete the database setup described in README.md, including chainlab_is_superadmin(), then set the non-secret deployment-tool flag SUPABASE_MIGRATION_APPLIED=1. This flag records operator confirmation; it does not verify the database.",
    );
  }
  console.log(
    "Required production variable names are present. Values and database readiness still require production validation.",
  );
}

await api(`/v9/projects/${encodeURIComponent(project.id)}`, "PATCH", {
  framework: "nextjs",
  nodeVersion: "24.x",
  ssoProtection: null,
  passwordProtection: null,
  trustedIps: null,
});
const verified = await api(`/v9/projects/${encodeURIComponent(project.id)}`);
if (
  verified.ssoProtection ||
  verified.passwordProtection ||
  verified.trustedIps
) {
  throw new Error(
    "Vercel still reports deployment protection enabled. Review project Settings → Deployment Protection.",
  );
}
console.log(
  `Verified ${scope}/${verified.name}; Vercel deployment protection is disabled. Application superadmin authentication remains required.`,
);

if (deploy) {
  const repoId = String(
    verified.link.repoId ||
      execFileSync("gh", ["api", `repos/${repository}`, "--jq", ".id"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }).trim(),
  );
  if (!/^\d+$/.test(repoId))
    throw new Error("Could not resolve the GitHub repository ID.");
  const deployment = await api("/v13/deployments", "POST", {
    name,
    project: verified.id,
    target: "production",
    gitSource: {
      type: "github",
      repoId,
      ref: process.env.DEPLOY_REF || "main",
    },
  });
  console.log(`Deployment requested: https://${deployment.url}`);
  console.log(
    "A request is not deployment validation. Check the Vercel build result, then test the production URL in Incognito mode.",
  );
}
