#!/usr/bin/env node
/**
 * Inspect only: node --use-env-proxy scripts/configure-supabase.mjs
 * Apply after review: node --use-env-proxy scripts/configure-supabase.mjs --apply
 * Credentials come only from SUPABASE_ACCESS_TOKEN. Never print token/API bodies.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const PROJECT_REF = "qrgjqpdvvbwmjpthpmlo";
const API_URL = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
export const RESERVED_TABLES = [
  "prompt_chains",
  "prompt_chain_steps",
  "prompt_chain_runs",
];
export const RESERVED_FUNCTIONS = [
  "guard_prompt_chain_superadmin_role",
  "is_prompt_chain_superadmin",
  "touch_prompt_chain_updated_at",
  "append_chain_step",
  "delete_chain_step",
  "reorder_chain_steps",
];
export const RESERVED_POLICIES = [
  "prompt_chain_read_own_profile",
  "prompt_chain_media_guard",
  "prompt_chain_media_superadmin",
];
const BUCKET = "prompt-chain-media";
class ConfigurationError extends Error {}
const quotedList = (values) => values.map((v) => `'${v}'`).join(",");

// Metadata only: no application rows, profile identities, credentials or emails.
export const INSPECT_SQL = `
select jsonb_build_object(
 'project_database', current_database(),
 'prerequisites', jsonb_build_object(
   'auth_users', to_regclass('auth.users') is not null,
   'storage_buckets', to_regclass('storage.buckets') is not null,
   'storage_objects', to_regclass('storage.objects') is not null),
 'tables', coalesce((select jsonb_agg(jsonb_build_object(
   'name', c.relname, 'rls', c.relrowsecurity,
   'columns', (select jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid,a.atttypmod), 'not_null', a.attnotnull) order by a.attnum)
      from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
   'id_unique', exists(select 1 from pg_index i join pg_attribute a on a.attrelid=c.oid and a.attname='id'
      where i.indrelid=c.oid and i.indisunique and i.indisvalid and i.indnkeyatts=1 and i.indkey[0]=a.attnum),
   'safe_admin_default', not exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid=c.oid and a.attname='is_superadmin' and lower(pg_get_expr(d.adbin,d.adrelid)) not in ('false','false::boolean','null::boolean'))
 )) from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind in ('r','p') and c.relname in ('profiles',${quotedList(RESERVED_TABLES)})), '[]'::jsonb),
 'functions', coalesce((select jsonb_agg(jsonb_build_object('name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'returns',pg_get_function_result(p.oid),'security_definer',p.prosecdef))
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (${quotedList(RESERVED_FUNCTIONS)})), '[]'::jsonb),
 'policies', coalesce((select jsonb_agg(jsonb_build_object('schema',schemaname,'table',tablename,'name',policyname,'permissive',permissive,'command',cmd)) from pg_policies
 where (schemaname='public' and tablename in ('profiles',${quotedList(RESERVED_TABLES)}))
    or (schemaname='storage' and tablename='objects' and policyname in (${quotedList(RESERVED_POLICIES)}))), '[]'::jsonb),
 'triggers', coalesce((select jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname)) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in ('profiles',${quotedList(RESERVED_TABLES)}) and not t.tgisinternal), '[]'::jsonb),
 'bucket', (select jsonb_build_object('id',id,'public',public,'file_size_limit',file_size_limit,'allowed_mime_types',allowed_mime_types) from storage.buckets where id='${BUCKET}')
) as inspection;
`;

export function preflight(metadata) {
  const blockers = [];
  if (!metadata || typeof metadata !== "object")
    return ["The Management API returned no structural metadata."];
  if (
    !metadata.prerequisites?.auth_users ||
    !metadata.prerequisites?.storage_buckets ||
    !metadata.prerequisites?.storage_objects
  )
    blockers.push("Required Supabase Auth or Storage schemas are missing.");
  if (
    !Array.isArray(metadata.tables) ||
    !Array.isArray(metadata.functions) ||
    !Array.isArray(metadata.policies) ||
    !Array.isArray(metadata.triggers)
  )
    return [
      ...blockers,
      "Structural metadata is incomplete; no write is permitted.",
    ];
  for (const table of metadata.tables) {
    if (RESERVED_TABLES.includes(table.name))
      blockers.push(
        `Existing public.${table.name} must be reviewed before applying this app migration.`,
      );
  }
  const profiles = metadata.tables.find((t) => t.name === "profiles");
  if (profiles) {
    const id = profiles.columns?.find((c) => c.name === "id");
    const admin = profiles.columns?.find((c) => c.name === "is_superadmin");
    if (!id || id.type !== "uuid" || !id.not_null || !profiles.id_unique)
      blockers.push(
        "Existing profiles.id must be a non-null UUID with a single-column unique or primary key.",
      );
    if (admin && admin.type !== "boolean")
      blockers.push("Existing profiles.is_superadmin is not boolean.");
    if (admin && !profiles.safe_admin_default)
      blockers.push(
        "Existing profiles.is_superadmin has an unsafe or unrecognized default.",
      );
  }
  for (const fn of metadata.functions) {
    if (RESERVED_FUNCTIONS.includes(fn.name))
      blockers.push(
        `Existing public.${fn.name} function requires an ownership review.`,
      );
  }
  for (const policy of metadata.policies) {
    if (RESERVED_POLICIES.includes(policy.name))
      blockers.push(
        `Existing ${policy.name} policy requires an ownership review.`,
      );
  }
  if (
    metadata.triggers.some(
      (t) => t.name === "guard_prompt_chain_superadmin_role",
    )
  )
    blockers.push(
      "The app role-guard trigger already exists; automatic replay is disabled.",
    );
  if (metadata.bucket)
    blockers.push(
      `The dedicated ${BUCKET} bucket already exists; automatic adoption is disabled.`,
    );
  return blockers;
}

export async function managementQuery(query, readOnly, token) {
  if (!token)
    throw new ConfigurationError(
      "SUPABASE_ACCESS_TOKEN is missing. Add it securely in environment settings.",
    );
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, read_only: readOnly }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new ConfigurationError(
      `Supabase Management API request failed (HTTP ${response.status}). No API response body or credentials were logged.`,
    );
  return response.json();
}

export function buildApplyQuery(migration) {
  if (
    (migration.match(/^begin;\s*$/gm) || []).length !== 1 ||
    (migration.match(/^commit;\s*$/gm) || []).length !== 1
  )
    throw new ConfigurationError(
      "The migration transaction format changed. Review the apply helper before proceeding.",
    );
  const content = migration
    .replace(/^begin;\s*$/m, "")
    .replace(/^commit;\s*$/m, "");
  // Recheck app object collisions inside the write transaction before any DDL.
  // There is intentionally no automatic replay or schema/table replacement.
  return `begin;
select pg_advisory_xact_lock(hashtext('prompt-chain-tool:initial-migration'));
do $guard$ begin
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (${quotedList(RESERVED_TABLES)}))
 or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (${quotedList(RESERVED_FUNCTIONS)}))
 or exists(select 1 from pg_policies where policyname in (${quotedList(RESERVED_POLICIES)}))
 or exists(select 1 from storage.buckets where id='${BUCKET}') then
  raise exception 'App object collision detected; migration aborted without adopting existing objects';
 end if;
end $guard$;
${content}
commit;`;
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log(
      "Usage: node --use-env-proxy scripts/configure-supabase.mjs [--apply]\nDefault: inspect schema metadata only. --apply refuses existing app objects and incompatible profiles.",
    );
    return;
  }
  if (
    args.some((a) => a !== "--apply") ||
    args.filter((a) => a === "--apply").length > 1
  )
    throw new ConfigurationError(
      "Only --apply or --help is supported. The target project is fixed in this script.",
    );
  if (
    (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) &&
    !process.execArgv.includes("--use-env-proxy") &&
    process.env.NODE_USE_ENV_PROXY !== "1"
  )
    throw new ConfigurationError(
      "Run with node --use-env-proxy to preserve the configured credential-injecting HTTPS proxy.",
    );
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token)
    throw new ConfigurationError(
      "SUPABASE_ACCESS_TOKEN is missing. Add it securely in environment settings.",
    );
  const rows = await managementQuery(INSPECT_SQL, true, token);
  const metadata = Array.isArray(rows) ? rows[0]?.inspection : null;
  const blockers = preflight(metadata);
  console.log(`Project: ${PROJECT_REF}\nRead-only structural inspection:`);
  // Only the fixed, metadata-only query result is shown. No auth/profile row data.
  console.log(JSON.stringify(metadata, null, 2));
  if (blockers.length) {
    console.log(
      `Apply preflight blocked:\n${blockers.map((b) => `- ${b}`).join("\n")}`,
    );
    if (args.includes("--apply"))
      throw new ConfigurationError(
        "No migration was applied. Review the shared project schema first.",
      );
    return;
  }
  console.log(
    "Apply preflight passed: no app-owned object collisions and compatible profiles schema.",
  );
  if (!args.includes("--apply")) {
    console.log("Read-only mode; no changes made.");
    return;
  }
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20261102000000_prompt_chains.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await managementQuery(buildApplyQuery(migration), false, token);
  console.log(
    "Migration API request completed. No superadmin grants were made. Inspect the schema and validate an authorized app session separately.",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    // Errors constructed above contain no response bodies or credential values.
    const message =
      error instanceof ConfigurationError
        ? error.message
        : "The Management API operation failed. Check runtime network, credential readiness and the local migration file.";
    console.error(message);
    process.exitCode = 1;
  });
}
