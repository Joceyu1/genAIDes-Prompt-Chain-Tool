import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderExistingSQL } from "../scripts/build-supabase-setup.mjs";

const admin = "11111111-1111-4111-8111-111111111111";
const member = "22222222-2222-4222-8222-222222222222";
const chain = "33333333-3333-4333-8333-333333333333";
const model = "44444444-4444-4444-8444-444444444444";
const step1 = "55555555-5555-4555-8555-555555555555";
const step2 = "66666666-6666-4666-8666-666666666666";
const step3 = "77777777-7777-4777-8777-777777777777";
const bootstrap = `
create role authenticated;create role anon;
create schema auth;create schema storage;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth,storage to authenticated,anon;
create table public.profiles(id uuid primary key references auth.users(id),is_superadmin boolean not null default false);
alter table public.profiles enable row level security;
grant all on public.profiles to authenticated;
create function public.is_columbia_google_user() returns boolean language sql stable as $$select false$$;
create policy columbia_profiles_guard on public.profiles as restrictive for all to authenticated using((select public.is_columbia_google_user())) with check((select public.is_columbia_google_user()));
create policy own_profile_read on public.profiles for select to authenticated using(id=auth.uid());
insert into auth.users values('${admin}'),('${member}');
insert into public.profiles values('${admin}',true),('${member}',false);
create table public.llm_providers(
 id uuid primary key,created_at timestamptz default now(),updated_at timestamptz default now(),
 name text,slug text,base_url text,description text,is_active boolean default true
);
insert into public.llm_providers(id,name,slug,base_url,is_active) values('88888888-8888-4888-8888-888888888888','Legacy provider','legacy_provider','https://provider-fixture.invalid/private',true);
create table public.llm_models(
 id uuid primary key,created_at timestamptz default now(),updated_at timestamptz default now(),
 provider_id uuid not null references public.llm_providers(id) on delete restrict,
 name text,model_key text,context_window integer,supports_images boolean,is_active boolean not null default true
);
insert into public.llm_models(id,provider_id,name,model_key,is_active) values('${model}','88888888-8888-4888-8888-888888888888','Legacy registry model','legacy-provider/model-version',true);
create table public.prompt_chains(
 id uuid primary key default gen_random_uuid(),
 name text not null unique check(char_length(name) between 1 and 120),
 description text not null default '' check(char_length(description)<=2000),
 is_active boolean not null default false,
 source text not null default 'source_snapshot' check(source='source_snapshot'),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.prompt_chain_steps(
 id uuid primary key default gen_random_uuid(),
 chain_id uuid not null references public.prompt_chains(id) on delete restrict,
 position integer not null check(position>=1 and position<=1000),
 role text not null check(role in ('system','user','assistant')),
 template text not null check(char_length(template) between 1 and 2000),
 model_id uuid references public.llm_models(id) on delete restrict,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(chain_id,position)
);
alter table public.prompt_chains enable row level security;
alter table public.prompt_chain_steps enable row level security;
grant select on public.prompt_chains,public.prompt_chain_steps to authenticated;
create table public.generations("generation key" uuid primary key,prompt text,title text,caption text,model text,status text,created_at timestamptz default now());
create table public.ai_generation_examples(id uuid primary key default gen_random_uuid(),chain_id uuid references public.prompt_chains(id) on delete restrict,prompt text,output text,is_active boolean default true,created_at timestamptz default now());
create table public.generation_requests(id uuid primary key default gen_random_uuid(),chain_id uuid references public.prompt_chains(id) on delete restrict,generation_id uuid references public.generations("generation key") on delete restrict,prompt text,status text,model_key text,source text,created_at timestamptz default now());
create table public.prompt_chain_mix(id uuid primary key default gen_random_uuid(),chain_id uuid references public.prompt_chains(id) on delete restrict);
create table public.step_external_reference(step_id uuid references public.prompt_chain_steps(id) on delete restrict);
create table storage.buckets(id text primary key,name text unique,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
alter table storage.objects enable row level security;
grant select,insert,delete on storage.objects to authenticated;
insert into storage.buckets values('avatars','avatars',false,null,null);
insert into storage.objects(bucket_id,name) values('avatars','existing-avatar.png');
create policy existing_avatars_guard on storage.objects as restrictive for all to authenticated
using(bucket_id<>'avatars' or (select public.is_columbia_google_user()))
with check(bucket_id<>'avatars' or (select public.is_columbia_google_user()));
insert into public.prompt_chains(id,name,description,is_active) values('${chain}','Existing assignment chain','Existing description',true);
insert into public.prompt_chain_steps(id,chain_id,position,role,template,model_id) values
 ('${step1}','${chain}',2,'system','Original system prompt','${model}'),
 ('${step2}','${chain}',8,'user','Original user prompt',null),
 ('${step3}','${chain}',1000,'assistant','Original assistant prompt','${model}');
`;
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const install = () => read("../supabase/install-existing-chain-admin.sql");
const asUser = (id: string) =>
  `reset role;set role authenticated;set request.jwt.claim.sub='${id}';`;
type RawStep = {
  id: string;
  position: number;
  role: string;
  template: string;
  model_id: string | null;
  created_at: string;
  updated_at: string;
};
type Snapshot = {
  chain: {
    id: string;
    name: string;
    description: string;
    source: string;
    is_active: boolean;
    created_at: string;
    updated_at: string;
  };
  steps: RawStep[];
  settings: Array<{
    step_id: string;
    name: string;
    kind: string;
    fallback_model: string;
  }>;
};
type StepResult = {
  step: RawStep;
  settings: { name: string; kind: string; fallback_model: string };
};
async function rpc<T = unknown>(
  db: PGlite,
  name: string,
  args: unknown[] = [],
): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(",");
  return (
    await db.query<{ result: T }>(
      `select public.${name}(${placeholders}) as result`,
      args,
    )
  ).rows[0].result;
}
const array = (ids: string[]) => `{${ids.join(",")}}`;
const policySnapshot = async (db: PGlite) =>
  (
    await db.query(
      "select policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename='profiles' order by policyname",
    )
  ).rows;
const constraintSnapshot = async (db: PGlite) =>
  (
    await db.query(
      "select conrelid::regclass::text as relation,conname,contype,condeferrable,condeferred,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid in ('public.prompt_chains'::regclass,'public.prompt_chain_steps'::regclass) order by relation,conname",
    )
  ).rows;
const predicateSnapshot = async (db: PGlite) =>
  (
    await db.query(
      "select p.oid,p.proowner,p.prosrc,p.proconfig,p.prosecdef,p.provolatile,p.pronargs from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='chainlab_is_superadmin' order by p.oid",
    )
  ).rows;
async function setup(preinstallPredicate = true) {
  const db = new PGlite();
  await db.exec(bootstrap);
  if (preinstallPredicate)
    await db.exec(
      read(
        "../supabase/migrations/20261104000000_chainlab_superadmin_check.sql",
      ),
    );
  const policies = await policySnapshot(db);
  const constraints = await constraintSnapshot(db);
  const predicate = await predicateSnapshot(db);
  await db.exec(install());
  await db.exec(asUser(admin));
  return { db, policies, constraints, predicate };
}

describe("administration of the existing assignment chain schema", () => {
  it("generates the guarded installer without altering existing chain tables or constraints", async () => {
    const { db, policies, constraints, predicate } = await setup();
    try {
      expect(install()).toBe(await renderExistingSQL());
      expect(install()).not.toMatch(/alter\s+table\s+public\.prompt_chain/i);
      const state = await rpc<Snapshot>(db, "chainlab_get_chain", [chain]);
      expect(state.chain).toMatchObject({
        name: "Existing assignment chain",
        source: "source_snapshot",
        is_active: true,
      });
      expect(state.steps.map((s) => s.position)).toEqual([2, 8, 1000]);
      expect(state.steps.map((s) => s.model_id)).toEqual([model, null, model]);
      expect((await db.query("select id from public.profiles")).rows).toEqual(
        [],
      );
      await db.exec("reset role");
      expect(await predicateSnapshot(db)).toEqual(predicate);
      expect(await policySnapshot(db)).toEqual(policies);
      expect(await constraintSnapshot(db)).toEqual(constraints);
      expect(
        (
          await db.query(
            "select id,is_superadmin from public.profiles order by id",
          )
        ).rows,
      ).toEqual([
        { id: admin, is_superadmin: true },
        { id: member, is_superadmin: false },
      ]);
      await expect(db.exec(install())).rejects.toThrow("already exists");
      await db.exec("rollback");
      expect(
        (
          await db.query(
            "select count(*)::integer as count from public.prompt_chain_steps",
          )
        ).rows,
      ).toEqual([{ count: 3 }]);
    } finally {
      await db.close();
    }
  });

  it("bootstraps the reviewed authorization function when it has not been installed", async () => {
    const { db, policies, constraints, predicate } = await setup(false);
    try {
      expect(predicate).toEqual([]);
      expect(install().match(/^begin;\s*$/gm)).toHaveLength(1);
      expect(install().match(/^commit;\s*$/gm)).toHaveLength(1);
      expect(await rpc(db, "chainlab_is_superadmin")).toBe(true);
      expect(
        (await rpc<Snapshot>(db, "chainlab_get_chain", [chain])).steps,
      ).toHaveLength(3);
      await db.exec(asUser(member));
      expect(await rpc(db, "chainlab_is_superadmin")).toBe(false);
      await db.exec("reset role");
      expect(await policySnapshot(db)).toEqual(policies);
      expect(await constraintSnapshot(db)).toEqual(constraints);
      expect(
        (
          await db.query(
            "select has_function_privilege('anon','public.chainlab_is_superadmin()','EXECUTE') as allowed",
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
    } finally {
      await db.close();
    }
  });

  it("rejects unknown predicates, overloads and unsafe owners without replacing their definitions", async () => {
    const db = new PGlite();
    try {
      await db.exec(bootstrap);
      await db.exec("create role untrusted_executor nosuperuser nobypassrls");
      const authMigration = read(
        "../supabase/migrations/20261104000000_chainlab_superadmin_check.sql",
      );
      const originalRows = (
        await db.query(
          "select * from public.prompt_chain_steps order by position",
        )
      ).rows;
      for (const candidate of [
        "returns true",
        "wrong signature",
        "extra overload",
        "unsafe owner",
      ]) {
        if (candidate === "returns true") {
          await db.exec(
            "create function public.chainlab_is_superadmin() returns boolean language sql stable security definer set search_path='' as $$ select true $$",
          );
        } else if (candidate === "wrong signature") {
          await db.exec(
            "create function public.chainlab_is_superadmin(p_id uuid) returns boolean language sql stable security definer set search_path='' as $$ select true $$",
          );
        } else {
          await db.exec(authMigration);
          if (candidate === "extra overload")
            await db.exec(
              "create function public.chainlab_is_superadmin(p_id uuid) returns boolean language sql stable security definer set search_path='' as $$ select false $$",
            );
          else
            await db.exec(
              "alter function public.chainlab_is_superadmin() owner to untrusted_executor",
            );
        }
        const before = await predicateSnapshot(db);
        await expect(db.exec(install())).rejects.toThrow(
          /Unknown chainlab_is_superadmin|owner cannot safely/,
        );
        await db.exec("rollback");
        expect(await predicateSnapshot(db)).toEqual(before);
        expect(
          (
            await db.query(
              "select to_regclass('public.chainlab_step_settings') is null as absent",
            )
          ).rows,
        ).toEqual([{ absent: true }]);
        expect(
          (
            await db.query(
              "select * from public.prompt_chain_steps order by position",
            )
          ).rows,
        ).toEqual(originalRows);
        await db.exec(
          "drop function if exists public.chainlab_is_superadmin();drop function if exists public.chainlab_is_superadmin(uuid)",
        );
      }
    } finally {
      await db.close();
    }
  });

  it("rolls back authorization bootstrap when an existing sidecar prevents installation", async () => {
    const db = new PGlite();
    try {
      await db.exec(bootstrap);
      await db.exec(
        "create table public.chainlab_step_settings(sentinel text);insert into public.chainlab_step_settings values('preserve unrelated table')",
      );
      await expect(db.exec(install())).rejects.toThrow("already exists");
      await db.exec("rollback");
      expect(await predicateSnapshot(db)).toEqual([]);
      expect(
        (await db.query("select sentinel from public.chainlab_step_settings"))
          .rows,
      ).toEqual([{ sentinel: "preserve unrelated table" }]);
      expect(
        (
          await db.query(
            "select count(*)::integer as count from public.prompt_chain_steps",
          )
        ).rows,
      ).toEqual([{ count: 3 }]);
    } finally {
      await db.close();
    }
  });

  it("advances modification timestamps while preserving row identities and creation timestamps", async () => {
    const { db } = await setup();
    try {
      const original = await rpc<Snapshot>(db, "chainlab_get_chain", [chain]);
      const created = new Map(original.steps.map((s) => [s.id, s.created_at]));
      const epoch = Date.parse("2000-01-01T00:00:00.000Z");
      const resetModified = async () => {
        await db.exec(
          `reset role;update public.prompt_chains set updated_at='2000-01-01' where id='${chain}';update public.prompt_chain_steps set updated_at='2000-01-01' where chain_id='${chain}'`,
        );
        await db.exec(asUser(admin));
      };
      const assertTouched = async () => {
        const state = await rpc<Snapshot>(db, "chainlab_get_chain", [chain]);
        expect(Date.parse(state.chain.updated_at)).toBeGreaterThan(epoch);
        expect(state.chain.created_at).toBe(original.chain.created_at);
        for (const s of state.steps)
          expect(s.created_at).toBe(created.get(s.id));
        return state;
      };
      await resetModified();
      await rpc(db, "chainlab_update_chain", [
        chain,
        JSON.stringify({ description: "Timestamp update" }),
      ]);
      await assertTouched();
      await resetModified();
      const edited = await rpc<StepResult>(db, "chainlab_update_step", [
        chain,
        step1,
        JSON.stringify({ template: "Timestamp prompt" }),
        JSON.stringify({}),
      ]);
      expect(Date.parse(edited.step.updated_at)).toBeGreaterThan(epoch);
      await assertTouched();
      await resetModified();
      const reordered = await rpc<Snapshot>(db, "chainlab_reorder_steps", [
        chain,
        array([step3, step2, step1]),
      ]);
      expect(
        reordered.steps.every((s) => Date.parse(s.updated_at) > epoch),
      ).toBe(true);
      await assertTouched();
      await resetModified();
      const appended = await rpc<StepResult>(db, "chainlab_append_step", [
        chain,
        JSON.stringify({ template: "Appended timestamp prompt" }),
        JSON.stringify({}),
      ]);
      created.set(appended.step.id, appended.step.created_at);
      expect(Date.parse(appended.step.updated_at)).toBeGreaterThan(epoch);
      await assertTouched();
      await resetModified();
      await rpc(db, "chainlab_delete_step", [chain, step3]);
      const remaining = await assertTouched();
      expect(remaining.steps.map((s) => s.id)).toEqual([
        step2,
        step1,
        appended.step.id,
      ]);
      expect(
        remaining.steps.every((s) => Date.parse(s.updated_at) > epoch),
      ).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("rolls back authorization and core installation on late registry, history or saved-history collisions", async () => {
    const db = new PGlite();
    try {
      await db.exec(bootstrap);
      const policies = await policySnapshot(db);
      const original = (
        await db.query(
          "select * from public.prompt_chain_steps order by position",
        )
      ).rows;
      const cases = [
        {
          prepare:
            "create function public.chainlab_list_models() returns jsonb language sql as $$select '[]'::jsonb$$",
          cleanup: "drop function public.chainlab_list_models()",
        },
        {
          prepare:
            "create table public.chainlab_runs(sentinel text);insert into public.chainlab_runs values('preserve unknown history')",
          cleanup: "drop table public.chainlab_runs",
        },
        {
          prepare:
            "insert into storage.buckets(id,name,public) values('chainlab-generated-media','chainlab-generated-media',true)",
          cleanup:
            "delete from storage.buckets where id='chainlab-generated-media'",
        },
        {
          prepare:
            "create function public.chainlab_list_legacy_history(p_chain_id uuid) returns jsonb language sql as $$select '[]'::jsonb$$",
          cleanup: "drop function public.chainlab_list_legacy_history(uuid)",
        },
      ];
      for (const collision of cases) {
        await db.exec(collision.prepare);
        await expect(db.exec(install())).rejects.toThrow(/already exists/);
        await db.exec("rollback");
        expect(await predicateSnapshot(db)).toEqual([]);
        expect(
          (
            await db.query(
              "select to_regclass('public.chainlab_step_settings') is null as absent",
            )
          ).rows,
        ).toEqual([{ absent: true }]);
        expect(
          (
            await db.query(
              "select * from public.prompt_chain_steps order by position",
            )
          ).rows,
        ).toEqual(original);
        expect(await policySnapshot(db)).toEqual(policies);
        if (collision.cleanup.startsWith("drop table"))
          expect(
            (await db.query("select sentinel from public.chainlab_runs")).rows,
          ).toEqual([{ sentinel: "preserve unknown history" }]);
        if (collision.cleanup.startsWith("delete"))
          expect(
            (
              await db.query(
                "select public from storage.buckets where id='chainlab-generated-media'",
              )
            ).rows,
          ).toEqual([{ public: true }]);
        await db.exec(collision.cleanup);
        expect(
          (
            await db.query(
              "select count(*)::integer as count from storage.buckets where id='chainlab-generated-media'",
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
      }
    } finally {
      await db.close();
    }
  });

  it("creates and patches chain metadata while preserving source and omitted values", async () => {
    const { db } = await setup();
    try {
      const created = await rpc<Snapshot>(db, "chainlab_create_chain", [
        "New chain",
        "Description",
        false,
      ]);
      expect(created.chain.source).toBe("source_snapshot");
      expect(created.steps).toEqual([]);
      const updated = await rpc<Snapshot>(db, "chainlab_update_chain", [
        created.chain.id,
        JSON.stringify({ name: "Renamed" }),
      ]);
      expect(updated.chain).toMatchObject({
        name: "Renamed",
        description: "Description",
        is_active: false,
        source: "source_snapshot",
      });
      await expect(
        rpc(db, "chainlab_update_chain", [
          created.chain.id,
          JSON.stringify({ source: "modified" }),
        ]),
      ).rejects.toMatchObject({ code: "22023" });
      await expect(
        rpc(db, "chainlab_create_chain", [
          "Existing assignment chain",
          "",
          true,
        ]),
      ).rejects.toMatchObject({ code: "23505" });
      await rpc(db, "chainlab_delete_chain", [created.chain.id]);
      await expect(
        rpc(db, "chainlab_get_chain", [created.chain.id]),
      ).rejects.toMatchObject({ code: "P0002" });
    } finally {
      await db.close();
    }
  });

  it("compacts sparse positions and saves step settings atomically without changing model UUIDs", async () => {
    const { db } = await setup();
    try {
      await expect(
        rpc(db, "chainlab_append_step", [
          chain,
          JSON.stringify({ role: "user", template: "New prompt" }),
          JSON.stringify({
            name: "Bad fallback",
            kind: "image",
            fallback_model: "gpt-4.1-mini",
          }),
        ]),
      ).rejects.toMatchObject({ code: "22023" });
      expect(
        (await rpc<Snapshot>(db, "chainlab_get_chain", [chain])).steps.map(
          (s) => s.position,
        ),
      ).toEqual([2, 8, 1000]);
      const appended = await rpc<StepResult>(db, "chainlab_append_step", [
        chain,
        JSON.stringify({ role: "user", template: "New prompt" }),
        JSON.stringify({
          name: "Final captions",
          kind: "text",
          fallback_model: "gpt-4.1-mini",
        }),
      ]);
      expect(appended.step.position).toBe(4);
      expect(appended.settings.name).toBe("Final captions");
      expect(
        (await rpc<Snapshot>(db, "chainlab_get_chain", [chain])).steps.map(
          (s) => s.id,
        ),
      ).toEqual([step1, step2, step3, appended.step.id]);
      const edited = await rpc<StepResult>(db, "chainlab_update_step", [
        chain,
        step1,
        JSON.stringify({ template: "Edited system prompt" }),
        JSON.stringify({
          name: "Custom model step",
          fallback_model: "legacy-provider/model-version",
        }),
      ]);
      expect(edited.step).toMatchObject({
        model_id: model,
        role: "system",
        template: "Edited system prompt",
      });
      expect(edited.settings.fallback_model).toBe("gpt-4.1-mini");
      const registeredAppend = await rpc<StepResult>(
        db,
        "chainlab_append_step",
        [
          chain,
          JSON.stringify({
            template: "Registered provider prompt",
            model_id: model,
          }),
          JSON.stringify({ name: "Registry assignment", fallback_model: "" }),
        ],
      );
      expect(registeredAppend.step.model_id).toBe(model);
      expect(registeredAppend.settings.fallback_model).toBe("gpt-4.1-mini");
      await db.exec(
        `reset role;update public.llm_models set is_active=false where id='${model}'`,
      );
      await db.exec(asUser(admin));
      for (const fallback of ["", "claude-custom"]) {
        const retained = await rpc<StepResult>(db, "chainlab_update_step", [
          chain,
          step1,
          JSON.stringify({ template: "Edited inactive registry prompt" }),
          JSON.stringify({ fallback_model: fallback }),
        ]);
        expect(retained.step.model_id).toBe(model);
        expect(retained.settings.fallback_model).toBe("gpt-4.1-mini");
      }
      await expect(
        rpc(db, "chainlab_update_step", [
          chain,
          step1,
          JSON.stringify({ model_id: null }),
          JSON.stringify({ fallback_model: "claude-custom" }),
        ]),
      ).rejects.toMatchObject({ code: "22023" });
      expect(
        (await rpc<Snapshot>(db, "chainlab_get_chain", [chain])).steps[0]
          .model_id,
      ).toBe(model);
      const cleared = await rpc<StepResult>(db, "chainlab_update_step", [
        chain,
        step1,
        JSON.stringify({ model_id: null }),
        JSON.stringify({ fallback_model: "gpt-4.1-mini" }),
      ]);
      expect(cleared.step.model_id).toBeNull();
      await expect(
        rpc(db, "chainlab_update_step", [
          chain,
          step1,
          JSON.stringify({ template: "x".repeat(2001) }),
          JSON.stringify({}),
        ]),
      ).rejects.toMatchObject({ code: "22023" });
      await expect(
        rpc(db, "chainlab_update_step", [
          chain,
          step1,
          JSON.stringify({ position: -1 }),
          JSON.stringify({}),
        ]),
      ).rejects.toMatchObject({ code: "22023" });
    } finally {
      await db.close();
    }
  });

  it("reorders with a free positive slot under immediate uniqueness and preserves external step references", async () => {
    const { db, constraints } = await setup();
    try {
      await db.exec(
        `reset role;insert into public.step_external_reference values('${step1}');`,
      );
      await db.exec(asUser(admin));
      const reordered = await rpc<Snapshot>(db, "chainlab_reorder_steps", [
        chain,
        array([step3, step1, step2]),
      ]);
      expect(reordered.steps.map((s) => [s.id, s.position])).toEqual([
        [step3, 1],
        [step1, 2],
        [step2, 3],
      ]);
      for (const ids of [[step1, step1, step2], [step1], [step1, step2, admin]])
        await expect(
          rpc(db, "chainlab_reorder_steps", [chain, array(ids)]),
        ).rejects.toMatchObject({ code: "22023" });
      expect(
        (await rpc<Snapshot>(db, "chainlab_get_chain", [chain])).steps.map(
          (s) => s.id,
        ),
      ).toEqual([step3, step1, step2]);
      await rpc(db, "chainlab_delete_step", [chain, step3]);
      expect(
        (await rpc<Snapshot>(db, "chainlab_get_chain", [chain])).steps.map(
          (s) => [s.id, s.position],
        ),
      ).toEqual([
        [step1, 1],
        [step2, 2],
      ]);
      await db.exec("reset role");
      expect(await constraintSnapshot(db)).toEqual(constraints);
      expect(
        (await db.query("select step_id from public.step_external_reference"))
          .rows,
      ).toEqual([{ step_id: step1 }]);
    } finally {
      await db.close();
    }
  });

  it("accepts a 1000-position no-op and rejects nontrivial full reorders before any changes", async () => {
    const { db } = await setup();
    try {
      const created = await rpc<Snapshot>(db, "chainlab_create_chain", [
        "Full chain",
        "",
        false,
      ]);
      const id = created.chain.id;
      await db.exec(
        `reset role;insert into public.prompt_chain_steps(chain_id,position,role,template) select '${id}',n,'user','Prompt '||n from generate_series(1,1000)n;`,
      );
      await db.exec(asUser(admin));
      const before = await rpc<Snapshot>(db, "chainlab_get_chain", [id]);
      const ids = before.steps.map((s) => s.id);
      expect(
        (await rpc<Snapshot>(db, "chainlab_reorder_steps", [id, array(ids)]))
          .steps,
      ).toEqual(before.steps);
      await expect(
        rpc(db, "chainlab_reorder_steps", [id, array([...ids].reverse())]),
      ).rejects.toMatchObject({ code: "22023" });
      await expect(
        rpc(db, "chainlab_append_step", [
          id,
          JSON.stringify({ template: "Overflow" }),
          JSON.stringify({}),
        ]),
      ).rejects.toMatchObject({ code: "22023" });
      expect(
        (await rpc<Snapshot>(db, "chainlab_get_chain", [id])).steps,
      ).toEqual(before.steps);
      await rpc(db, "chainlab_delete_step", [id, ids[0]]);
      const appended = await rpc<StepResult>(db, "chainlab_append_step", [
        id,
        JSON.stringify({ template: "Replacement" }),
        JSON.stringify({}),
      ]);
      expect(appended.step.position).toBe(1000);
    } finally {
      await db.close();
    }
  }, 30000);

  it.each([
    "ai_generation_examples",
    "generation_requests",
    "prompt_chain_mix",
  ])(
    "rolls back step and settings deletion when %s protects a chain",
    async (table) => {
      const { db } = await setup();
      try {
        await rpc(db, "chainlab_update_step", [
          chain,
          step1,
          JSON.stringify({}),
          JSON.stringify({ name: "Preserved settings" }),
        ]);
        const before = await rpc<Snapshot>(db, "chainlab_get_chain", [chain]);
        await db.exec(
          `reset role;insert into public.${table}(chain_id) values('${chain}');`,
        );
        await db.exec(asUser(admin));
        await expect(
          rpc(db, "chainlab_delete_chain", [chain]),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/^(23001|23503)$/),
        });
        expect(await rpc<Snapshot>(db, "chainlab_get_chain", [chain])).toEqual(
          before,
        );
      } finally {
        await db.close();
      }
    },
  );

  it("denies every entry point to ordinary and anonymous users without promoting a profile", async () => {
    const { db } = await setup();
    try {
      const calls: Array<[string, unknown[]]> = [
        ["chainlab_list_chains", []],
        ["chainlab_get_chain", [chain]],
        ["chainlab_create_chain", ["Denied", "", false]],
        ["chainlab_update_chain", [chain, JSON.stringify({ name: "Denied" })]],
        ["chainlab_delete_chain", [chain]],
        [
          "chainlab_append_step",
          [chain, JSON.stringify({ template: "Denied" }), JSON.stringify({})],
        ],
        [
          "chainlab_update_step",
          [chain, step1, JSON.stringify({}), JSON.stringify({})],
        ],
        ["chainlab_delete_step", [chain, step1]],
        ["chainlab_reorder_steps", [chain, array([step1, step2, step3])]],
      ];
      await db.exec(asUser(member));
      for (const [name, args] of calls)
        await expect(rpc(db, name, args)).rejects.toMatchObject({
          code: "42501",
        });
      await db.exec(
        "update public.profiles set is_superadmin=true where id=auth.uid()",
      );
      await expect(
        db.query("select * from public.chainlab_step_settings"),
      ).rejects.toMatchObject({ code: "42501" });
      await db.exec(
        `reset role;set role anon;set request.jwt.claim.sub='${admin}'`,
      );
      for (const [name, args] of calls)
        await expect(rpc(db, name, args)).rejects.toMatchObject({
          code: "42501",
        });
      await db.exec("reset role");
      expect(
        (
          await db.query(
            `select is_superadmin from public.profiles where id='${member}'`,
          )
        ).rows,
      ).toEqual([{ is_superadmin: false }]);
      const definitions = (
        await db.query<{
          prosecdef: boolean;
          proconfig: string[];
          definition: string;
        }>(
          "select prosecdef,proconfig,pg_get_functiondef(oid) as definition from pg_proc where proname in ('chainlab_list_chains','chainlab_get_chain','chainlab_create_chain','chainlab_update_chain','chainlab_delete_chain','chainlab_append_step','chainlab_update_step','chainlab_delete_step','chainlab_reorder_steps')",
        )
      ).rows;
      expect(definitions).toHaveLength(9);
      for (const fn of definitions) {
        expect(fn.prosecdef).toBe(true);
        expect(fn.proconfig).toEqual(['search_path=""']);
        expect(fn.definition).toMatch(
          /chainlab_is_superadmin\(\) IS NOT TRUE/i,
        );
      }
    } finally {
      await db.close();
    }
  });
});
