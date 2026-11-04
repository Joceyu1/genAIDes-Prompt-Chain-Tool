import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const admin = "11111111-1111-4111-8111-111111111111";
const member = "22222222-2222-4222-8222-222222222222";
const chain = "33333333-3333-4333-8333-333333333333";
const otherChain = "44444444-4444-4444-8444-444444444444";
const generation = "55555555-5555-4555-8555-555555555555";
const sameId = "66666666-6666-4666-8666-666666666666";
const sql = readFileSync(
  new URL(
    "../supabase/migrations/20261104040000_chainlab_legacy_history.sql",
    import.meta.url,
  ),
  "utf8",
);
const authSQL = readFileSync(
  new URL(
    "../supabase/migrations/20261104000000_chainlab_superadmin_check.sql",
    import.meta.url,
  ),
  "utf8",
);
const asUser = (id: string) =>
  `reset role;set role authenticated;set request.jwt.claim.sub='${id}';`;
const bootstrap = `
create role authenticated;create role anon;create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to authenticated,anon;
create table public.profiles(id uuid primary key references auth.users(id),is_superadmin boolean);
alter table public.profiles enable row level security;
create function public.is_columbia_google_user() returns boolean language sql stable as $$select false$$;
create policy columbia_profiles_guard on public.profiles as restrictive for all to authenticated using((select public.is_columbia_google_user()));
insert into auth.users values('${admin}'),('${member}');
insert into public.profiles values('${admin}',true),('${member}',false);
create table public.prompt_chains(id uuid primary key,source text not null default 'source_snapshot');
insert into public.prompt_chains(id) values('${chain}'),('${otherChain}');
create table public.generations("generation key" uuid primary key,prompt text,title text,caption text,model text,status text,created_at timestamptz,private_image_url text);
insert into public.generations values('${generation}','Generation prompt','A stylish cat','The cat is the new head of fashion.','gpt-4.1-mini','ready_for_caption','2026-11-02','https://private.example/image.png');
create table public.generation_requests(id uuid primary key default gen_random_uuid(),chain_id uuid references public.prompt_chains(id) on delete restrict,generation_id uuid references public.generations("generation key"),prompt text not null,status text not null,model_key text,source text not null default 'service_role_generation',created_at timestamptz not null default now());
create table public.ai_generation_examples(id uuid primary key default gen_random_uuid(),chain_id uuid references public.prompt_chains(id) on delete restrict,prompt text not null,output text not null,is_active boolean not null default true,created_at timestamptz not null default now());
insert into public.generation_requests(id,chain_id,generation_id,prompt,status,model_key,created_at) values('${sameId}','${chain}','${generation}','Request prompt','completed','fallback-model','2026-11-03');
insert into public.ai_generation_examples(id,chain_id,prompt,output,created_at) values('${sameId}','${chain}','Example prompt','Saved funny text','2026-11-02');
insert into public.ai_generation_examples(chain_id,prompt,output) values('${otherChain}','Other chain prompt','Other chain output');
`;
async function setup() {
  const db = new PGlite();
  await db.exec(bootstrap);
  for (const table of [
    "prompt_chains",
    "generations",
    "generation_requests",
    "ai_generation_examples",
  ]) {
    await db.exec(
      `alter table public.${table} enable row level security;grant select on public.${table} to authenticated;create policy columbia_guard on public.${table} as restrictive for all to authenticated using((select public.is_columbia_google_user()));`,
    );
  }
  await db.exec(authSQL);
  await db.exec(sql);
  await db.exec(asUser(admin));
  return db;
}
const list = async (db: PGlite, id = chain) =>
  (
    await db.query<{ result: Array<Record<string, unknown>> }>(
      "select public.chainlab_list_legacy_history($1) as result",
      [id],
    )
  ).rows[0].result;
describe("existing assignment saved history RPC", () => {
  it("joins through the actual quoted FK column and exposes known text only", async () => {
    const db = await setup();
    try {
      expect((await db.query("select * from public.generations")).rows).toEqual(
        [],
      );
      const result = await list(db);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        source: "generation_request",
        id: sameId,
        chain_id: chain,
        prompt: "Request prompt",
        status: "completed",
        title: "A stylish cat",
        caption: "The cat is the new head of fashion.",
        model: "gpt-4.1-mini",
        generation_prompt: "Generation prompt",
        generation_status: "ready_for_caption",
        origin: "service_role_generation",
        output: null,
        truncated: false,
      });
      expect(result[1]).toMatchObject({
        source: "saved_example",
        id: sameId,
        prompt: "Example prompt",
        output: "Saved funny text",
        status: "saved",
      });
      expect(JSON.stringify(result)).not.toContain("private.example");
      expect(JSON.stringify(result)).not.toContain("Other chain");
      await db.exec("reset role");
      expect(
        (await db.query("select private_image_url from public.generations"))
          .rows,
      ).toEqual([{ private_image_url: "https://private.example/image.png" }]);
      expect(
        (await db.query("select source from public.prompt_chains order by id"))
          .rows,
      ).toEqual([{ source: "source_snapshot" }, { source: "source_snapshot" }]);
      expect(
        (
          await db.query(
            "select permissive from pg_policies where tablename='generations'",
          )
        ).rows,
      ).toEqual([{ permissive: "RESTRICTIVE" }]);
    } finally {
      await db.close();
    }
  });
  it("denies members and anonymous callers before reading any history", async () => {
    const db = await setup();
    try {
      await db.exec(asUser(member));
      await expect(list(db)).rejects.toThrow(/Superadmin access required/);
      await db.exec("reset role;set role anon;set request.jwt.claim.sub='';");
      await expect(list(db)).rejects.toThrow(/permission denied/);
    } finally {
      await db.close();
    }
  });
  it("keeps unlinked requests and marks truncated preview text without rewriting originals", async () => {
    const db = await setup();
    try {
      await db.exec("reset role");
      await db.query(
        "insert into public.generation_requests(chain_id,prompt,status,model_key,created_at) values($1,'Waiting prompt','queued','queued-model','2026-11-05')",
        [chain],
      );
      await db.query(
        "update public.ai_generation_examples set output=repeat('x',20001),is_active=false where chain_id=$1",
        [chain],
      );
      await db.exec(asUser(admin));
      const result = await list(db);
      expect(result[0]).toMatchObject({
        status: "queued",
        title: null,
        caption: null,
        generation_prompt: null,
        model: "queued-model",
      });
      const example = result.find((entry) => entry.source === "saved_example");
      expect(example).toMatchObject({ status: "inactive", truncated: true });
      expect((example?.output as string).length).toBe(20000);
      await db.exec("reset role");
      expect(
        (
          await db.query<{ length: number }>(
            "select char_length(output) as length from public.ai_generation_examples where chain_id=$1",
            [chain],
          )
        ).rows[0].length,
      ).toBe(20001);
    } finally {
      await db.close();
    }
  });
  it("limits combined history to the newest 50 and rejects missing chains", async () => {
    const db = await setup();
    try {
      await db.exec("reset role");
      await db.query(
        "insert into public.ai_generation_examples(chain_id,prompt,output,created_at) select $1,'Prompt','Output','2026-11-06'::timestamptz+i*interval '1 second' from generate_series(1,60) i",
        [chain],
      );
      await db.exec(asUser(admin));
      const result = await list(db);
      expect(result).toHaveLength(50);
      expect(
        new Date(result[0].created_at as string).getTime(),
      ).toBeGreaterThan(new Date(result[49].created_at as string).getTime());
      await expect(list(db, member)).rejects.toThrow(/Prompt chain not found/);
    } finally {
      await db.close();
    }
  });
  it("aborts installation when the FK target is not the confirmed generations table", async () => {
    const db = new PGlite();
    try {
      await db.exec(bootstrap);
      await db.exec(authSQL);
      await db.exec(
        "alter table public.generation_requests drop constraint generation_requests_generation_id_fkey;create table public.unrelated_generations(id uuid primary key);delete from public.generation_requests;alter table public.generation_requests add foreign key(generation_id) references public.unrelated_generations(id)",
      );
      await expect(db.exec(sql)).rejects.toThrow(/Expected one UUID/);
      await db.exec("rollback");
      expect(
        (
          await db.query(
            "select to_regprocedure('public.chainlab_list_legacy_history(uuid)') as function",
          )
        ).rows,
      ).toEqual([{ function: null }]);
    } finally {
      await db.close();
    }
  });
});
