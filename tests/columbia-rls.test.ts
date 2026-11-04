import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  renderRepairSQL,
  renderSetupSQL,
} from "../scripts/build-supabase-setup.mjs";

const admin = "11111111-1111-4111-8111-111111111111";
const member = "22222222-2222-4222-8222-222222222222";
const absent = "44444444-4444-4444-8444-444444444444";
const chain = "33333333-3333-4333-8333-333333333333";
const bootstrap = `
create role authenticated; create role anon;
create schema auth; create schema storage;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
grant usage on schema auth,public,storage to authenticated,anon;
grant execute on function auth.uid(),auth.role() to authenticated,anon;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
alter table storage.objects enable row level security;
grant all on storage.objects to authenticated,anon;
create table public.profiles(id uuid primary key references auth.users(id),is_superadmin boolean not null default false);
alter table public.profiles enable row level security;
grant all on public.profiles to authenticated;
-- Represents the existing Columbia guard rejecting a non-Columbia Google user.
create function public.is_columbia_google_user() returns boolean language sql stable as $$ select false $$;
create policy columbia_profiles_guard on public.profiles as restrictive for all to authenticated
 using ((select public.is_columbia_google_user())) with check ((select public.is_columbia_google_user()));
create policy own_profile_read on public.profiles for select to authenticated using(id=auth.uid());
insert into auth.users values('${admin}'),('${member}');
insert into public.profiles values('${admin}',true),('${member}',false);
`;
const asUser = (id: string) =>
  `reset role; set role authenticated; set request.jwt.claim.role='authenticated'; set request.jwt.claim.sub='${id}';`;
const storedSetup = () =>
  readFileSync(new URL("../supabase/setup.sql", import.meta.url), "utf8");
const policySnapshot = async (db: PGlite) =>
  (
    await db.query(
      `select policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename='profiles' order by policyname`,
    )
  ).rows;

async function installed() {
  const db = new PGlite();
  await db.exec(bootstrap);
  const policies = await policySnapshot(db);
  await db.exec(storedSetup());
  return { db, policies };
}

describe("superadmin authorization with the existing restrictive Columbia policy", () => {
  it("repairs authorization without adopting existing chain tables or changing profiles", async () => {
    const db = new PGlite();
    try {
      await db.exec(bootstrap);
      await db.exec(`
create table public.prompt_chains(id integer primary key,title text);
insert into public.prompt_chains values(17,'Existing chain');
create table public.prompt_chain_steps(id integer primary key,chain_id integer,description text);
insert into public.prompt_chain_steps values(23,17,'Existing step');
`);
      const policies = await policySnapshot(db);
      const profiles = (
        await db.query("select * from public.profiles order by id")
      ).rows;
      const chains = (await db.query("select * from public.prompt_chains"))
        .rows;
      const steps = (await db.query("select * from public.prompt_chain_steps"))
        .rows;
      const repair = readFileSync(
        new URL("../supabase/repair-superadmin-access.sql", import.meta.url),
        "utf8",
      );
      expect(repair).toBe(await renderRepairSQL());
      expect(repair).not.toMatch(/create\s+or\s+replace\s+function/i);
      expect(repair).not.toMatch(
        /(?:create|alter|drop)\s+(?:table|policy|trigger)|update\s+public\.profiles/i,
      );
      await db.exec(repair);
      await db.exec(asUser(admin));
      expect((await db.query("select id from public.profiles")).rows).toEqual(
        [],
      );
      expect(
        (await db.query("select public.chainlab_is_superadmin() as allowed"))
          .rows,
      ).toEqual([{ allowed: true }]);
      await db.exec(asUser(member));
      expect(
        (await db.query("select public.chainlab_is_superadmin() as allowed"))
          .rows,
      ).toEqual([{ allowed: false }]);
      await db.exec(
        `reset role;set role anon;set request.jwt.claim.sub='${admin}'`,
      );
      await expect(
        db.query("select public.chainlab_is_superadmin()"),
      ).rejects.toMatchObject({ code: "42501" });
      await db.exec("reset role");
      expect(
        (await db.query("select * from public.profiles order by id")).rows,
      ).toEqual(profiles);
      expect(
        (await db.query("select * from public.prompt_chains")).rows,
      ).toEqual(chains);
      expect(
        (await db.query("select * from public.prompt_chain_steps")).rows,
      ).toEqual(steps);
      expect(await policySnapshot(db)).toEqual(policies);
      expect(
        (
          await db.query(
            "select to_regclass('public.prompt_chain_runs') is null as runs_absent,to_regclass('public.prompt_chain_steps') is not null as steps_present",
          )
        ).rows,
      ).toEqual([{ runs_absent: true, steps_present: true }]);
      await expect(db.exec(repair)).rejects.toThrow(
        "repair aborted without replacing it",
      );
      await db.exec("rollback");
      expect(
        (await db.query("select * from public.prompt_chains")).rows,
      ).toEqual(chains);
      expect(await policySnapshot(db)).toEqual(policies);
    } finally {
      await db.close();
    }
  });

  it("generates a single guarded transaction from both reviewed migrations", async () => {
    const setup = storedSetup();
    expect(setup).toBe(await renderSetupSQL());
    expect(setup.match(/^begin;\s*$/gm)).toHaveLength(1);
    expect(setup.match(/^commit;\s*$/gm)).toHaveLength(1);
    expect(setup.indexOf("App object collision detected")).toBeLessThan(
      setup.indexOf("create table if not exists public.profiles"),
    );
  });

  it("returns only the caller's existing flag while preserving hidden profile rows and policies", async () => {
    const { db, policies } = await installed();
    try {
      expect(await policySnapshot(db)).toEqual(policies);
      const initial = (
        await db.query("select * from public.profiles order by id")
      ).rows;
      await db.exec(asUser(admin));
      expect((await db.query("select id from public.profiles")).rows).toEqual(
        [],
      );
      expect(
        (
          await db.query(
            "select public.chainlab_is_superadmin() as allowed,public.is_prompt_chain_superadmin() as baseline_allowed",
          )
        ).rows,
      ).toEqual([{ allowed: true, baseline_allowed: true }]);
      await expect(
        db.query(`select public.chainlab_is_superadmin('${member}'::uuid)`),
      ).rejects.toMatchObject({ code: "42883" });
      await db.exec(asUser(member));
      expect(
        (
          await db.query(
            "select public.chainlab_is_superadmin() as allowed,public.is_prompt_chain_superadmin() as baseline_allowed",
          )
        ).rows,
      ).toEqual([{ allowed: false, baseline_allowed: false }]);
      expect((await db.query("select id from public.profiles")).rows).toEqual(
        [],
      );
      await db.exec(asUser(absent));
      expect(
        (await db.query("select public.chainlab_is_superadmin() as allowed"))
          .rows,
      ).toEqual([{ allowed: false }]);
      await db.exec(asUser(""));
      expect(
        (await db.query("select public.chainlab_is_superadmin() as allowed"))
          .rows,
      ).toEqual([{ allowed: false }]);
      await db.exec("reset role");
      expect(
        (await db.query("select * from public.profiles order by id")).rows,
      ).toEqual(initial);
      expect(await policySnapshot(db)).toEqual(policies);
    } finally {
      await db.close();
    }
  });

  it("limits function execution to authenticated callers and hardens its definition", async () => {
    const { db } = await installed();
    try {
      expect(
        (
          await db.query(
            `select prosecdef,provolatile,pronargs,prorettype='boolean'::regtype as returns_boolean,proconfig from pg_proc where oid='public.chainlab_is_superadmin()'::regprocedure`,
          )
        ).rows,
      ).toEqual([
        {
          prosecdef: true,
          provolatile: "s",
          pronargs: 0,
          returns_boolean: true,
          proconfig: ['search_path=""'],
        },
      ]);
      expect(
        (
          await db.query(
            `select has_function_privilege('authenticated','public.chainlab_is_superadmin()','EXECUTE') as authenticated_allowed,has_function_privilege('anon','public.chainlab_is_superadmin()','EXECUTE') as anon_allowed`,
          )
        ).rows,
      ).toEqual([{ authenticated_allowed: true, anon_allowed: false }]);
      await db.exec(
        `set role anon; set request.jwt.claim.role='anon'; set request.jwt.claim.sub='${admin}'`,
      );
      await expect(
        db.query("select public.chainlab_is_superadmin()"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.close();
    }
  });

  it("keeps chain and step CRUD available to the same existing superadmin and denied to members", async () => {
    const { db, policies } = await installed();
    try {
      await db.exec(asUser(admin));
      await db.exec(
        `insert into public.prompt_chains(id,name) values('${chain}','Gmail admin chain'); update public.prompt_chains set description='Updated' where id='${chain}';`,
      );
      const steps = (
        await db.query<{ id: string }>(
          `select * from public.append_chain_step('${chain}','Describe','Describe input','text','gpt-4.1-mini')`,
        )
      ).rows;
      expect(steps).toHaveLength(1);
      await db.exec(
        `update public.prompt_chain_steps set name='Updated step' where id='${steps[0].id}';`,
      );
      expect(
        (await db.query("select name from public.prompt_chain_steps")).rows,
      ).toEqual([{ name: "Updated step" }]);
      await db.exec(asUser(member));
      expect(
        (await db.query("select id from public.prompt_chains")).rows,
      ).toEqual([]);
      expect(
        (await db.query("select id from public.prompt_chain_steps")).rows,
      ).toEqual([]);
      await expect(
        db.exec("insert into public.prompt_chains(name) values('denied')"),
      ).rejects.toMatchObject({ code: "42501" });
      await db.exec(
        "update public.profiles set is_superadmin=true where id=auth.uid()",
      );
      await db.exec(asUser(admin));
      await db.exec(
        `select public.delete_chain_step('${chain}','${steps[0].id}'); delete from public.prompt_chains where id='${chain}';`,
      );
      expect(
        (await db.query("select id from public.prompt_chains")).rows,
      ).toEqual([]);
      await db.exec("reset role");
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
      expect(await policySnapshot(db)).toEqual(policies);
    } finally {
      await db.close();
    }
  });

  it.each(["table", "bucket", "predicate"])(
    "aborts the whole setup instead of adopting an existing %s",
    async (collision) => {
      const db = new PGlite();
      try {
        await db.exec(bootstrap);
        if (collision === "table")
          await db.exec(
            "create table public.prompt_chains(sentinel text);insert into public.prompt_chains values('keep existing data')",
          );
        if (collision === "bucket")
          await db.exec(
            "insert into storage.buckets(id,name,public) values('prompt-chain-media','existing',true)",
          );
        if (collision === "predicate")
          await db.exec(
            "create function public.chainlab_is_superadmin() returns boolean language sql as $$ select false $$",
          );
        await expect(db.exec(storedSetup())).rejects.toThrow(
          "App object collision detected",
        );
        await db.exec("rollback");
        expect(
          (
            await db.query(
              "select to_regclass('public.prompt_chain_steps') is null as steps_absent",
            )
          ).rows,
        ).toEqual([{ steps_absent: true }]);
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
        if (collision === "table")
          expect(
            (await db.query("select sentinel from public.prompt_chains")).rows,
          ).toEqual([{ sentinel: "keep existing data" }]);
        if (collision === "bucket")
          expect(
            (
              await db.query(
                "select public from storage.buckets where id='prompt-chain-media'",
              )
            ).rows,
          ).toEqual([{ public: true }]);
      } finally {
        await db.close();
      }
    },
  );
});
