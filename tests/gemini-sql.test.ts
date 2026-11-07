import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderGeminiUpgradeSQL } from "../scripts/build-supabase-setup.mjs";
import {
  GEMINI_TEXT_MODEL_PATTERN,
  getModelProvider,
} from "../lib/model-catalog";

const admin = "11111111-1111-4111-8111-111111111111";
const member = "22222222-2222-4222-8222-222222222222";
const chain = "33333333-3333-4333-8333-333333333333";
const assignedModel = "44444444-4444-4444-8444-444444444444";
const assignedStep = "55555555-5555-4555-8555-555555555555";
const fallbackStep = "66666666-6666-4666-8666-666666666666";
const read = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const core = () =>
  read("supabase/migrations/20261104020000_existing_chain_admin.sql");
const upgrade = () => read("supabase/enable-gemini.sql");
const legacyPredicate =
  "(v_settings.kind='text' and v_settings.fallback_model in ('gpt-4.1-mini','gpt-4.1','gpt-4o-mini'))";
const geminiPredicate = `(v_settings.kind='text' and (
      v_settings.fallback_model in ('gpt-4.1-mini','gpt-4.1','gpt-4o-mini')
      or v_settings.fallback_model ~ '^gemini-([0-9]+([.][0-9]+)?-flash(-lite)?(-(001|latest|preview(-[0-9]{2}(-[0-9]{2,4})?)?))?|flash-lite-latest)$'
    ))`;
const legacyCore = () => {
  expect(core().split(geminiPredicate)).toHaveLength(2);
  return core().replace(geminiPredicate, legacyPredicate);
};
const asUser = (id: string) =>
  `reset role;set role authenticated;set request.jwt.claim.sub='${id}';`;
const bootstrap = `
create role anon;create role authenticated;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth,public to authenticated,anon;
create table public.profiles(id uuid primary key references auth.users(id),is_superadmin boolean not null default false);
alter table public.profiles enable row level security;
grant select on public.profiles to authenticated;
create policy own_profile_read on public.profiles for select to authenticated using(id=auth.uid());
create policy columbia_profiles_guard on public.profiles as restrictive for all to authenticated using(false) with check(false);
insert into auth.users values('${admin}'),('${member}');
insert into public.profiles values('${admin}',true),('${member}',false);
create table public.llm_models(id uuid primary key,is_active boolean not null default true);
insert into public.llm_models values('${assignedModel}',false);
create table public.prompt_chains(
 id uuid primary key default gen_random_uuid(),name text not null unique check(char_length(name) between 1 and 120),
 description text not null default '' check(char_length(description)<=2000),is_active boolean not null default true,
 source text not null default 'source_snapshot' check(source='source_snapshot'),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.prompt_chain_steps(
 id uuid primary key default gen_random_uuid(),chain_id uuid not null references public.prompt_chains(id) on delete restrict,
 position integer not null check(position between 1 and 1000),role text not null check(role in ('system','user','assistant')),
 template text not null check(char_length(template) between 1 and 2000),model_id uuid references public.llm_models(id) on delete restrict,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(chain_id,position)
);
alter table public.prompt_chains enable row level security;
alter table public.prompt_chain_steps enable row level security;
insert into public.prompt_chains(id,name,description) values('${chain}','Caption Test','Existing description');
insert into public.prompt_chain_steps(id,chain_id,position,role,template,model_id) values
 ('${assignedStep}','${chain}',1,'system','Original assigned prompt','${assignedModel}'),
 ('${fallbackStep}','${chain}',2,'user','Original fallback prompt',null);
`;

async function setup(legacy = true) {
  const db = new PGlite();
  await db.exec(bootstrap);
  await db.exec(
    read("supabase/migrations/20261104000000_chainlab_superadmin_check.sql"),
  );
  await db.exec(legacy ? legacyCore() : core());
  await db.exec(asUser(admin));
  await update(db, { fallback_model: "gpt-4.1-mini", name: "Funny captions" });
  await db.exec("reset role");
  return db;
}

async function update(
  db: PGlite,
  settings: Record<string, unknown>,
  step = fallbackStep,
  patch: Record<string, unknown> = {},
) {
  return (
    await db.query<{ result: Record<string, any> }>(
      "select public.chainlab_update_step($1,$2,$3,$4) as result",
      [chain, step, JSON.stringify(patch), JSON.stringify(settings)],
    )
  ).rows[0].result;
}

async function snapshot(db: PGlite) {
  return (
    await db.query(`select jsonb_build_object(
      'chains',(select jsonb_agg(to_jsonb(c) order by id) from public.prompt_chains c),
      'steps',(select jsonb_agg(to_jsonb(s) order by id) from public.prompt_chain_steps s),
      'settings',(select jsonb_agg(to_jsonb(t) order by step_id) from public.chainlab_step_settings t),
      'profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p),
      'models',(select jsonb_agg(to_jsonb(m) order by id) from public.llm_models m),
      'policies',(select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p where schemaname='public'),
      'constraints',(select jsonb_agg(jsonb_build_object('relation',conrelid::regclass::text,'name',conname,'definition',pg_get_constraintdef(oid)) order by conname) from pg_constraint where conrelid in ('public.prompt_chains'::regclass,'public.prompt_chain_steps'::regclass,'public.profiles'::regclass)),
      'grants',(select jsonb_agg(to_jsonb(g) order by table_name,grantee,privilege_type) from information_schema.table_privileges g where table_schema='public')
    ) as result`)
  ).rows;
}

async function functionSnapshot(db: PGlite) {
  return (
    await db.query<{
      oid: number;
      proowner: number;
      proacl: unknown;
      prosrc: string;
      prosecdef: boolean;
      proconfig: string[];
      proargnames: string[];
    }>(
      "select oid,proowner,proacl,prosrc,prosecdef,proconfig,proargnames from pg_proc where oid='public.chainlab_update_step(uuid,uuid,jsonb,jsonb)'::regprocedure",
    )
  ).rows[0];
}

describe("safe Gemini fallback upgrade", () => {
  it("generates the small upgrade from its versioned migration", async () => {
    expect(upgrade()).toBe(await renderGeminiUpgradeSQL());
    expect(upgrade()).not.toMatch(
      /alter\s+table|(?:insert\s+into|delete\s+from)\s+public\./i,
    );
    const body = legacyCore().match(
      /create function public\.chainlab_update_step\([\s\S]*?\bas \$\$([\s\S]*?)\$\$;/,
    )?.[1];
    expect(body).toBeDefined();
    expect(
      createHash("md5").update(body!.replaceAll("\r\n", "\n")).digest("hex"),
    ).toBe("a30484c8f12c6a91bf4a0fd9e5e53f40");
    expect(core()).toContain(`~ '${GEMINI_TEXT_MODEL_PATTERN}'`);
  });

  it("updates only the known function and preserves data, owner, OID, ACLs and policies", async () => {
    const db = await setup();
    try {
      const data = await snapshot(db);
      const before = await functionSnapshot(db);
      await db.exec(asUser(admin));
      await expect(
        update(db, { fallback_model: "gemini-flash-lite-latest" }),
      ).rejects.toMatchObject({ code: "22023" });
      await db.exec("reset role");
      await db.exec(upgrade());
      expect(await snapshot(db)).toEqual(data);
      const after = await functionSnapshot(db);
      expect({ ...after, prosrc: before.prosrc }).toEqual(before);
      expect(after.prosrc).toContain("gemini-");
      await db.exec(upgrade());
      expect(await functionSnapshot(db)).toEqual(after);
      expect(await snapshot(db)).toEqual(data);
      await db.exec(asUser(admin));
      const saved = await update(db, {
        fallback_model: "gemini-flash-lite-latest",
      });
      expect(saved.settings).toMatchObject({
        name: "Funny captions",
        kind: "text",
        fallback_model: "gemini-flash-lite-latest",
      });
      expect(saved.step).toMatchObject({ id: fallbackStep, model_id: null });
    } finally {
      await db.close();
    }
  });

  it("supports appending Gemini steps and preserves explicit OpenAI and registry choices", async () => {
    const db = await setup();
    try {
      await db.exec(upgrade());
      await db.exec(asUser(admin));
      const openai = await update(db, { fallback_model: "gpt-4.1" });
      expect(openai.settings.fallback_model).toBe("gpt-4.1");
      const assigned = await update(
        db,
        { fallback_model: "", name: "Assigned stays assigned" },
        assignedStep,
        { template: "Edited assigned prompt" },
      );
      expect(assigned.step).toMatchObject({
        id: assignedStep,
        model_id: assignedModel,
        role: "system",
      });
      expect(assigned.settings.fallback_model).toBe("gpt-4.1-mini");
      const appended = await db.query<{ result: Record<string, any> }>(
        "select public.chainlab_append_step($1,$2,$3) as result",
        [
          chain,
          JSON.stringify({
            template: "Write captions for {{input}}",
            role: "user",
          }),
          JSON.stringify({
            name: "Gemini captions",
            kind: "text",
            fallback_model: "gemini-3.8-flash",
          }),
        ],
      );
      expect(appended.rows[0].result.settings.fallback_model).toBe(
        "gemini-3.8-flash",
      );
      expect(appended.rows[0].result.step.position).toBe(3);
    } finally {
      await db.close();
    }
  });

  it("accepts safe Flash IDs and rejects unsupported modalities, URLs and images", async () => {
    const db = await setup(false);
    try {
      await db.exec(upgrade());
      await db.exec(asUser(admin));
      for (const model of [
        "gemini-flash-lite-latest",
        "gemini-3.8-flash",
        "gemini-3.5-flash-lite",
        "gemini-2.5-flash-preview-06-17",
        "gemini-2.0-flash-001",
      ]) {
        expect(getModelProvider(model)).toBe("gemini");
        expect(
          (await update(db, { fallback_model: model })).settings.fallback_model,
        ).toBe(model);
      }
      for (const model of [
        "gemini-flash-latest",
        "gemini-3.8-pro",
        "gemini-3.8-flash-image",
        "gemini-3.8-flash-preview-tts",
        "gemini-3.8-flash-native-audio",
        "https://example.com/model",
        "models/gemini-3.8-flash",
        "gemini-3.8-flash\n",
      ]) {
        if (!model.startsWith("models/"))
          expect(getModelProvider(model)).toBeUndefined();
        await expect(
          update(db, { fallback_model: model }),
        ).rejects.toMatchObject({ code: "22023" });
      }
      await expect(
        update(db, { kind: "image", fallback_model: "gemini-3.8-flash" }),
      ).rejects.toMatchObject({ code: "22023" });
      expect(
        (await update(db, { kind: "image", fallback_model: "gpt-image-1" }))
          .settings.kind,
      ).toBe("image");
    } finally {
      await db.close();
    }
  });

  it("keeps authenticated members and anonymous callers out of step mutations", async () => {
    const db = await setup();
    try {
      await db.exec(upgrade());
      await db.exec(asUser(member));
      await expect(
        update(db, { fallback_model: "gemini-flash-lite-latest" }),
      ).rejects.toMatchObject({ code: "42501" });
      await db.exec("reset role;set role anon;set request.jwt.claim.sub='';");
      await expect(
        update(db, { fallback_model: "gemini-flash-lite-latest" }),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.close();
    }
  });

  it.each(["body", "comment newline", "configuration", "owner", "overload"])(
    "refuses an unknown function %s without changing data",
    async (change) => {
      const db = await setup();
      try {
        if (change === "body") {
          await db.exec(
            `create or replace function public.chainlab_update_step(p_chain_id uuid,p_step_id uuid,p_step jsonb,p_settings jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin return '{}'::jsonb;end;$$;`,
          );
        } else if (change === "comment newline") {
          const declaration = legacyCore().match(
            /create function public\.chainlab_update_step\([\s\S]*?\n\$\$;/,
          )![0];
          const altered = declaration.replace(
            "-- or prevent editing the existing prompt.\n    if v_step.model_id",
            "-- or prevent editing the existing prompt.    if v_step.model_id",
          );
          expect(altered).not.toBe(declaration);
          expect(altered.toLowerCase().replace(/\s+/g, "")).toBe(
            declaration.toLowerCase().replace(/\s+/g, ""),
          );
          await db.exec(
            altered.replace("create function", "create or replace function"),
          );
        } else if (change === "configuration") {
          await db.exec(
            "alter function public.chainlab_update_step(uuid,uuid,jsonb,jsonb) security invoker",
          );
        } else if (change === "owner") {
          await db.exec(
            "create role untrusted_owner;alter function public.chainlab_update_step(uuid,uuid,jsonb,jsonb) owner to untrusted_owner",
          );
        } else {
          await db.exec(
            "create function public.chainlab_update_step(text) returns jsonb language sql as $$select '{}'::jsonb$$",
          );
        }
        const data = await snapshot(db);
        const before = await functionSnapshot(db);
        await expect(db.exec(upgrade())).rejects.toThrow(/upgrade|trusted/i);
        await db.exec("rollback");
        expect(await snapshot(db)).toEqual(data);
        expect(await functionSnapshot(db)).toEqual(before);
      } finally {
        await db.close();
      }
    },
  );
});
