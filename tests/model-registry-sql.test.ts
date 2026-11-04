import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20261104025000_chainlab_model_registry.sql",
    import.meta.url,
  ),
  "utf8",
);
const superadminMigration = readFileSync(
  new URL(
    "../supabase/migrations/20261104000000_chainlab_superadmin_check.sql",
    import.meta.url,
  ),
  "utf8",
);
const admin = "11111111-1111-4111-8111-111111111111";
const member = "22222222-2222-4222-8222-222222222222";
const provider = "33333333-3333-4333-8333-333333333333";
const inactiveProvider = "44444444-4444-4444-8444-444444444444";
const otherProvider = "55555555-5555-4555-8555-555555555555";
const modelIds = Array.from(
  { length: 7 },
  (_, i) => `66666666-6666-4666-8666-${String(i + 1).padStart(12, "0")}`,
);

const bootstrap = `
create role authenticated; create role anon;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
grant usage on schema auth,public to authenticated,anon;
create table public.profiles(id uuid primary key references auth.users(id),is_superadmin boolean not null default false);
alter table public.profiles enable row level security;
grant select on public.profiles to authenticated;
create function public.is_columbia_google_user() returns boolean language sql stable as $$select false$$;
create policy columbia_profiles_guard on public.profiles as restrictive for all to authenticated
  using((select public.is_columbia_google_user())) with check((select public.is_columbia_google_user()));
create policy own_profile_read on public.profiles for select to authenticated using(id=auth.uid());
insert into auth.users values('${admin}'),('${member}');
insert into public.profiles values('${admin}',true),('${member}',false);
create table public.llm_providers(
  id uuid primary key,created_at timestamptz default now(),updated_at timestamptz default now(),
  name text,slug text,base_url text,description text,is_active boolean,
  private_config jsonb default '{"fixture_private":"never-return"}'::jsonb
);
create table public.llm_models(
  id uuid primary key,created_at timestamptz default now(),updated_at timestamptz default now(),
  provider_id uuid not null references public.llm_providers(id),name text,model_key text,
  context_window integer,supports_images boolean,is_active boolean,
  private_notes text default 'fixture-private-notes'
);
alter table public.llm_providers enable row level security;
alter table public.llm_models enable row level security;
create policy registry_hidden on public.llm_models as restrictive for all to authenticated using(false);
grant select on public.llm_models to authenticated;
insert into public.llm_providers(id,name,slug,base_url,description,is_active) values
  ('${provider}','OpenAI','OpenAI','https://fixture.example/private-openai','private provider description',true),
  ('${inactiveProvider}','Inactive OpenAI','OpenAI','https://fixture.example/private-disabled','private disabled description',false),
  ('${otherProvider}','Anthropic','Anthropic','https://fixture.example/private-anthropic','private other description',true);
insert into public.llm_models(id,provider_id,name,model_key,context_window,supports_images,is_active) values
  ('${modelIds[0]}','${provider}','Vision text','gpt-4.1-mini',1000000,true,true),
  ('${modelIds[1]}','${provider}','Image output','gpt-image-1',null,false,true),
  ('${modelIds[2]}','${provider}','Disabled model','gpt-4o-mini',128000,true,false),
  ('${modelIds[3]}','${inactiveProvider}','Disabled provider model','gpt-4.1',1000000,true,true),
  ('${modelIds[4]}','${otherProvider}','Other vision model','claude-fixture',200000,true,true),
  ('${modelIds[5]}','${provider}',null,null,null,true,null),
  ('${modelIds[6]}','${provider}','   ','custom-key',null,false,true);
`;

type ModelDescriptor = {
  id: string;
  label: string;
  model: string;
  provider: string;
  kind: "text" | "image" | null;
  active: boolean;
};
const asUser = (id: string) =>
  `reset role;set role authenticated;set request.jwt.claim.sub='${id}';`;
const listModels = async (db: PGlite) =>
  (
    await db.query<{ models: ModelDescriptor[] }>(
      "select public.chainlab_list_models() as models",
    )
  ).rows[0].models;
const originalSnapshot = async (db: PGlite) => ({
  models: (await db.query("select * from public.llm_models order by id")).rows,
  providers: (await db.query("select * from public.llm_providers order by id"))
    .rows,
  profiles: (await db.query("select * from public.profiles order by id")).rows,
  policies: (
    await db.query(
      `select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
       from pg_policies where schemaname='public' order by tablename,policyname`,
    )
  ).rows,
  grants: (
    await db.query(
      `select relname,relacl,relrowsecurity,relforcerowsecurity from pg_class
       where oid in ('public.llm_models'::regclass,'public.llm_providers'::regclass,'public.profiles'::regclass)
       order by relname`,
    )
  ).rows,
});

async function prepared() {
  const db = new PGlite();
  await db.exec(bootstrap);
  await db.exec(superadminMigration);
  return db;
}

describe("existing model registry RPC", () => {
  it("lists curated descriptors for an existing superadmin despite restrictive profile RLS", async () => {
    const db = await prepared();
    try {
      const before = await originalSnapshot(db);
      await db.exec(migration);
      await db.exec(asUser(admin));
      expect((await db.query("select id from public.profiles")).rows).toEqual(
        [],
      );
      expect((await db.query("select id from public.llm_models")).rows).toEqual(
        [],
      );
      const models = await listModels(db);
      expect(models).toHaveLength(modelIds.length);
      for (const descriptor of models) {
        expect(Object.keys(descriptor).sort()).toEqual(
          ["id", "label", "model", "provider", "kind", "active"].sort(),
        );
        expect(typeof descriptor.active).toBe("boolean");
        expect(descriptor.label.trim().length).toBeGreaterThan(0);
      }
      const byId = Object.fromEntries(models.map((model) => [model.id, model]));
      expect(byId[modelIds[0]]).toEqual({
        id: modelIds[0],
        label: "Vision text",
        model: "gpt-4.1-mini",
        provider: "openai",
        kind: "text",
        active: true,
      });
      expect(byId[modelIds[1]].kind).toBe("image");
      expect(byId[modelIds[2]]).toMatchObject({ kind: "text", active: false });
      expect(byId[modelIds[3]]).toMatchObject({ kind: "text", active: false });
      expect(byId[modelIds[4]]).toMatchObject({
        model: "claude-fixture",
        provider: "anthropic",
        kind: null,
        active: true,
      });
      expect(byId[modelIds[5]]).toMatchObject({
        label: "Unnamed model",
        model: "",
        kind: null,
        active: false,
      });
      expect(byId[modelIds[6]].label).toBe("custom-key");
      expect(JSON.stringify(models)).not.toMatch(
        /fixture\.example|private|description|base_url|context_window|supports_images/i,
      );
      await db.exec("reset role");
      expect(await originalSnapshot(db)).toEqual(before);
    } finally {
      await db.close();
    }
  });

  it("denies non-superadmins and anon, and fixes the function execution context and ACL", async () => {
    const db = await prepared();
    try {
      await db.exec(migration);
      await db.exec(asUser(member));
      await expect(listModels(db)).rejects.toMatchObject({ code: "42501" });
      await db.exec(
        `reset role;set role anon;set request.jwt.claim.sub='${admin}';`,
      );
      await expect(listModels(db)).rejects.toMatchObject({ code: "42501" });
      await db.exec("reset role");
      expect(
        (
          await db.query(`select prosecdef,provolatile,pronargs,proconfig,
            prorettype='jsonb'::regtype as returns_jsonb
            from pg_proc where oid='public.chainlab_list_models()'::regprocedure`)
        ).rows,
      ).toEqual([
        {
          prosecdef: true,
          provolatile: "s",
          pronargs: 0,
          proconfig: ['search_path=""'],
          returns_jsonb: true,
        },
      ]);
      expect(
        (
          await db.query(`select
            has_function_privilege('authenticated','public.chainlab_list_models()','EXECUTE') as authenticated_allowed,
            has_function_privilege('anon','public.chainlab_list_models()','EXECUTE') as anon_allowed,
            exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl) acl
              where p.oid='public.chainlab_list_models()'::regprocedure and acl.grantee=0 and acl.privilege_type='EXECUTE') as public_allowed`)
        ).rows,
      ).toEqual([
        {
          authenticated_allowed: true,
          anon_allowed: false,
          public_allowed: false,
        },
      ]);
    } finally {
      await db.close();
    }
  });

  it("returns an empty array for an empty registry", async () => {
    const db = await prepared();
    try {
      await db.exec("delete from public.llm_models");
      await db.exec(migration);
      await db.exec(asUser(admin));
      expect(await listModels(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it.each(["()", "(unused integer)"])(
    "rejects an existing function name %s without replacing it or changing registry data",
    async (signature) => {
      const db = await prepared();
      try {
        await db.exec(
          `create function public.chainlab_list_models${signature} returns text language sql as $$select 'original-sentinel'$$;`,
        );
        const before = await originalSnapshot(db);
        const functionsBefore = (
          await db.query(
            "select oid,prosrc,proacl from pg_proc where pronamespace='public'::regnamespace and proname='chainlab_list_models'",
          )
        ).rows;
        await expect(db.exec(migration)).rejects.toThrow(
          /already exists.*without replacing/i,
        );
        await db.exec("rollback");
        expect(await originalSnapshot(db)).toEqual(before);
        expect(
          (
            await db.query(
              "select oid,prosrc,proacl from pg_proc where pronamespace='public'::regnamespace and proname='chainlab_list_models'",
            )
          ).rows,
        ).toEqual(functionsBefore);
      } finally {
        await db.close();
      }
    },
  );

  it.each([
    "alter table public.llm_models drop column model_key",
    "alter table public.llm_models alter column model_key type varchar(200)",
    "alter table public.llm_providers alter column is_active type text using is_active::text",
    "drop function public.chainlab_is_superadmin()",
  ])("fails closed for incompatible schema: %s", async (change) => {
    const db = await prepared();
    try {
      await db.exec(change);
      const before = await originalSnapshot(db);
      await expect(db.exec(migration)).rejects.toThrow(
        /incompatible type|predicate is required/i,
      );
      await db.exec("rollback");
      expect(await originalSnapshot(db)).toEqual(before);
      expect(
        (
          await db.query(
            "select to_regprocedure('public.chainlab_list_models()') is null as absent",
          )
        ).rows,
      ).toEqual([{ absent: true }]);
    } finally {
      await db.close();
    }
  });
});
