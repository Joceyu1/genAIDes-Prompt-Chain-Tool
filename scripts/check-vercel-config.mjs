/** Offline checks for deployment targeting and prerequisite gates. Run: node scripts/check-vercel-config.mjs */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = (
  await readFile(new URL("./configure-vercel.mjs", import.meta.url), "utf8")
)
  .replace(/^#!.*\n/, "")
  .replace(/^import .*;\n/m, "");
const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
  "process",
  "fetch",
  "console",
  "AbortSignal",
  "execFileSync",
  source,
);
const project = {
  id: "prj_test",
  name: "genaides-prompt-chain-tool",
  accountId: "team_test",
  link: {
    type: "github",
    org: "Joceyu1",
    repo: "genAIDes-Prompt-Chain-Tool",
    repoId: 12345,
  },
};
async function run({ overrides = {}, args = [], responses, expectError }) {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({
      path: url.pathname,
      query: url.searchParams,
      method: options.method,
      body: options.body ? JSON.parse(options.body) : undefined,
    });
    // Preserve fallback fixtures while separately testing scoped-token lookup.
    if (
      url.pathname === "/v9/projects/genaides-prompt-chain-tool" &&
      url.searchParams.get("slug") === "jocelyn13" &&
      responses[0]?.path !== url.pathname
    ) {
      return new Response(JSON.stringify({ error: { code: "not_found" } }), {
        status: 404,
      });
    }
    const next = responses.shift();
    assert.ok(next, `Unexpected request ${url.pathname}`);
    assert.equal(url.pathname, next.path);
    return new Response(JSON.stringify(next.body), {
      status: next.status || 200,
    });
  };
  const promise = execute(
    {
      argv: ["node", "script", "--apply", ...args],
      env: { VERCEL_TOKEN: "test-fixture-only", ...overrides },
    },
    fakeFetch,
    { log() {} },
    AbortSignal,
    () => {
      throw new Error("Unexpected GitHub command");
    },
  );
  if (expectError) await assert.rejects(promise, expectError);
  else await promise;
  assert.equal(responses.length, 0, "All expected requests should run");
  return calls;
}
const teamResponses = () => [
  {
    path: "/v2/teams",
    body: { teams: [{ id: "team_test", slug: "jocelyn13" }], pagination: {} },
  },
];
const missing = await run({
  responses: [
    ...teamResponses(),
    {
      path: "/v9/projects/genaides-prompt-chain-tool",
      status: 404,
      body: { error: { code: "not_found" } },
    },
  ],
  expectError: /No project was created/,
});
assert.ok(missing.every((call) => call.method === "GET"));
assert.equal(missing.at(-1).query.get("teamId"), "team_test");
await run({
  overrides: { VERCEL_TEAM_ID: "team_other" },
  responses: [
    { path: "/v2/teams/team_other", body: { id: "team_other", slug: "other" } },
  ],
  expectError: /does not match/,
});
await run({
  responses: [
    { path: "/v2/teams", body: { teams: [], pagination: {} } },
    { path: "/v2/user", body: { user: { username: "other" } } },
  ],
  expectError: /Cannot resolve/,
});
await run({
  responses: [
    ...teamResponses(),
    {
      path: "/v9/projects/genaides-prompt-chain-tool",
      body: {
        ...project,
        link: { type: "github", org: "other", repo: "other" },
      },
    },
  ],
  expectError: /different GitHub repository/,
});
const protectionCalls = await run({
  responses: [
    ...teamResponses(),
    { path: "/v9/projects/genaides-prompt-chain-tool", body: project },
    { path: "/v9/projects/prj_test", body: project },
    {
      path: "/v9/projects/prj_test",
      body: {
        ...project,
        ssoProtection: null,
        passwordProtection: null,
        trustedIps: null,
      },
    },
  ],
});
const mutation = protectionCalls.find((call) => call.method === "PATCH");
assert.deepEqual(mutation.body, {
  framework: "nextjs",
  nodeVersion: "24.x",
  ssoProtection: null,
  passwordProtection: null,
  trustedIps: null,
});
assert.equal(mutation.query.get("teamId"), "team_test");
await run({
  args: ["--deploy"],
  responses: [
    ...teamResponses(),
    { path: "/v9/projects/genaides-prompt-chain-tool", body: project },
    { path: "/v10/projects/prj_test/env", body: { envs: [] } },
  ],
  expectError: /Missing production environment/,
});
const envs = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "AI_API_KEY",
].map((key) => ({ key, target: ["production"] }));
await run({
  args: ["--deploy"],
  responses: [
    ...teamResponses(),
    { path: "/v9/projects/genaides-prompt-chain-tool", body: project },
    { path: "/v10/projects/prj_test/env", body: { envs } },
  ],
  expectError: /Complete the database setup/,
});
const deployCalls = await run({
  args: ["--deploy"],
  overrides: { SUPABASE_MIGRATION_APPLIED: "1" },
  responses: [
    ...teamResponses(),
    { path: "/v9/projects/genaides-prompt-chain-tool", body: project },
    { path: "/v10/projects/prj_test/env", body: { envs } },
    { path: "/v9/projects/prj_test", body: project },
    { path: "/v9/projects/prj_test", body: project },
    { path: "/v13/deployments", body: { url: "example.vercel.app" } },
  ],
});
assert.equal(
  deployCalls.find((call) => call.path.endsWith("/env")).query.get("decrypt"),
  "false",
);
assert.deepEqual(deployCalls.at(-1).body.gitSource, {
  type: "github",
  repoId: "12345",
  ref: "main",
});
for (const providerKey of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
  const geminiEnvs = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    providerKey,
  ].map((key) => ({ key, target: ["production"] }));
  const calls = await run({
    args: ["--deploy"],
    overrides: { SUPABASE_MIGRATION_APPLIED: "1" },
    responses: [
      ...teamResponses(),
      { path: "/v9/projects/genaides-prompt-chain-tool", body: project },
      { path: "/v10/projects/prj_test/env", body: { envs: geminiEnvs } },
      { path: "/v9/projects/prj_test", body: project },
      { path: "/v9/projects/prj_test", body: project },
      { path: "/v13/deployments", body: { url: "example.vercel.app" } },
    ],
  });
  assert.equal(calls.at(-1).body.target, "production");
  assert.equal(
    calls.find((call) => call.path.endsWith("/env")).query.get("decrypt"),
    "false",
  );
}
await run({
  args: ["--deploy"],
  overrides: { SUPABASE_MIGRATION_APPLIED: "1" },
  responses: [
    ...teamResponses(),
    { path: "/v9/projects/genaides-prompt-chain-tool", body: project },
    {
      path: "/v10/projects/prj_test/env",
      body: { envs: envs.filter((entry) => entry.key !== "AI_API_KEY") },
    },
  ],
  expectError:
    /GEMINI_API_KEY or GOOGLE_API_KEY or AI_API_KEY or OPENAI_API_KEY/,
});
const personalCalls = await run({
  responses: [
    { path: "/v2/teams", body: { teams: [], pagination: {} } },
    { path: "/v2/user", body: { user: { username: "jocelyn13" } } },
    {
      path: "/v9/projects/genaides-prompt-chain-tool",
      status: 404,
      body: { error: { code: "not_found" } },
    },
  ],
  expectError: /No project was created/,
});
assert.equal(personalCalls.at(-1).query.has("teamId"), false);
const publicOverrides = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_fixture",
  AI_API_KEY: "proxy-placeholder-test-fixture",
  GEMINI_API_KEY: "proxy-placeholder-gemini-test-fixture",
};
const syncCalls = await run({
  args: ["--sync-public-env"],
  overrides: publicOverrides,
  responses: [
    ...teamResponses(),
    { path: "/v9/projects/genaides-prompt-chain-tool", body: project },
    { path: "/v10/projects/prj_test/env", body: { envs: [] } },
    { path: "/v9/projects/prj_test", body: project },
    { path: "/v9/projects/prj_test", body: project },
  ],
});
const syncCall = syncCalls.find((call) => call.path.endsWith("/env"));
assert.equal(syncCall.query.get("upsert"), "true");
assert.deepEqual(
  syncCall.body.map((entry) => entry.key),
  ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"],
);
assert.ok(
  syncCall.body.every(
    (entry) =>
      entry.type === "encrypted" &&
      entry.target.join(",") === "production,preview",
  ),
);
assert.ok(!JSON.stringify(syncCall.body).includes("proxy-placeholder"));
for (const keyValue of [
  "sb_secret_test_fixture",
  "proxy-placeholder",
  `header.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signature`,
]) {
  await run({
    args: ["--sync-public-env"],
    overrides: {
      ...publicOverrides,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: keyValue,
    },
    responses: [],
    expectError: /must be a Supabase anon\/publishable key/,
  });
}
await run({
  args: ["--sync-public-env"],
  overrides: {
    ...publicOverrides,
    NEXT_PUBLIC_SUPABASE_URL: "http://example.supabase.co",
  },
  responses: [],
  expectError: /must be an HTTPS/,
});
const scopedCalls = await run({
  responses: [
    { path: "/v9/projects/genaides-prompt-chain-tool", body: project },
    { path: "/v9/projects/prj_test", body: project },
    { path: "/v9/projects/prj_test", body: project },
  ],
});
assert.equal(scopedCalls[0].query.get("slug"), "jocelyn13");
assert.ok(
  !scopedCalls.some(
    (call) => call.path.includes("/teams") || call.path === "/v2/user",
  ),
);
assert.equal(scopedCalls.at(-1).query.get("teamId"), "team_test");
assert.equal(
  scopedCalls.find((call) => call.method === "PATCH").body.nodeVersion,
  "24.x",
);
await run({
  responses: [
    {
      path: "/v9/projects/genaides-prompt-chain-tool",
      body: { ...project, name: "different-project" },
    },
  ],
  expectError: /unexpected name/,
});
await run({
  overrides: { VERCEL_TEAM_ID: "team_other" },
  responses: [
    { path: "/v9/projects/genaides-prompt-chain-tool", body: project },
  ],
  expectError: /does not match the exact-scope/,
});
console.log(
  "20 offline deployment checks passed: exact scope, scoped tokens, Node.js version, missing project, mismatched scope/repository, protection removal, OpenAI/Gemini production variable names, migration prerequisite, deployment payload, and public-only Supabase sync.",
);
