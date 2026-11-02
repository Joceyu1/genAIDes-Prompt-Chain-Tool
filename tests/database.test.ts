import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("executes the migration and enforces role, storage and atomic ordering constraints", async () => {
  const db = new PGlite();
  let passed = 0;
  function assert(value: boolean, label: string) {
    expect(value, label).toBe(true);
    passed++;
  }
  async function query(
    sql: string,
  ): Promise<
    { admin?: boolean; id?: string; position?: number; public?: boolean }[]
  > {
    return (
      await db.query<{
        admin?: boolean;
        id?: string;
        position?: number;
        public?: boolean;
      }>(sql)
    ).rows;
  }
  async function fail(sql: string, code: string, label: string) {
    await expect(db.exec(sql), label).rejects.toMatchObject({ code });
    passed++;
  }
  try {
    await db.exec(`
create role authenticated; create role anon; create role service_role;
create schema auth; create schema storage;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
grant usage on schema auth,public,storage to authenticated,anon,service_role;
grant execute on function auth.uid(),auth.role() to authenticated,anon,service_role;
create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
insert into storage.buckets(id,name,public) values('generated-media','generated-media',true);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
alter table storage.objects enable row level security;
grant all on storage.objects to authenticated,anon;
-- Deliberately permissive legacy Storage policy to exercise restrictive guard.
create policy legacy_storage on storage.objects for all to public using (true) with check (true);
create table public.profiles(id uuid primary key references auth.users(id),is_superadmin boolean not null default false);
alter table public.profiles enable row level security;
grant all on public.profiles to authenticated;
create policy legacy_profile_self on public.profiles for all to authenticated using (id=auth.uid()) with check(id=auth.uid());
insert into auth.users values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
insert into public.profiles values('11111111-1111-4111-8111-111111111111',true),('22222222-2222-4222-8222-222222222222',false);
`);
    await db.exec(
      readFileSync(
        new URL(
          "../supabase/migrations/20261102000000_prompt_chains.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert(true, "migration executes against PostgreSQL");
    assert(
      (
        await query(
          `select public from storage.buckets where id='generated-media'`,
        )
      )[0].public === true,
      "unrelated existing media bucket is unchanged",
    );
    await db.exec(
      `set role authenticated; set request.jwt.claim.role='authenticated'; set request.jwt.claim.sub='22222222-2222-4222-8222-222222222222';`,
    );
    assert(
      (await query(`select public.is_prompt_chain_superadmin() as admin`))[0]
        .admin === false,
      "ordinary user is not superadmin",
    );
    await fail(
      `update public.profiles set is_superadmin=true where id=auth.uid();`,
      "42501",
      "legacy profile policy cannot self-promote",
    );
    await fail(
      `select public.append_chain_step('33333333-3333-4333-8333-333333333333','test','test','text','gpt-4.1-mini');`,
      "42501",
      "ordinary user cannot invoke step RPC",
    );
    await fail(
      `insert into public.prompt_chains(name) values('denied')`,
      "42501",
      "ordinary user cannot create chain",
    );
    await fail(
      `insert into storage.objects(bucket_id,name) values('prompt-chain-media','denied.png')`,
      "42501",
      "legacy storage policy cannot expose generated media",
    );
    await db.exec(
      `set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';`,
    );
    assert(
      (await query(`select public.is_prompt_chain_superadmin() as admin`))[0]
        .admin === true,
      "existing superadmin preserved",
    );
    await db.exec(
      `insert into public.prompt_chains(id,name) values('33333333-3333-4333-8333-333333333333','Test chain');`,
    );
    assert(true, "superadmin creates chain");
    let step1 = (
      await query(
        `select * from public.append_chain_step('33333333-3333-4333-8333-333333333333','one','Describe input','text','gpt-4.1-mini')`,
      )
    )[0];
    let step2 = (
      await query(
        `select * from public.append_chain_step('33333333-3333-4333-8333-333333333333','two','Draw input','image','gpt-image-1')`,
      )
    )[0];
    assert(
      step1.position === 0 && step2.position === 1,
      "append uses ordered positions",
    );
    let reordered = await query(
      `select * from public.reorder_chain_steps('33333333-3333-4333-8333-333333333333',array['${step2.id}','${step1.id}']::uuid[])`,
    );
    assert(
      reordered[0].id === step2.id &&
        reordered[0].position === 0 &&
        reordered[1].id === step1.id,
      "reorder swaps positions atomically",
    );
    await fail(
      `select public.reorder_chain_steps('33333333-3333-4333-8333-333333333333',array['${step1.id}','${step1.id}']::uuid[])`,
      "22023",
      "duplicate reorder IDs rejected",
    );
    await fail(
      `select public.reorder_chain_steps('33333333-3333-4333-8333-333333333333',array['${step1.id}']::uuid[])`,
      "22023",
      "incomplete reorder IDs rejected",
    );
    await fail(
      `select public.reorder_chain_steps('33333333-3333-4333-8333-333333333333',array['${step1.id}','44444444-4444-4444-8444-444444444444']::uuid[])`,
      "22023",
      "foreign reorder IDs rejected",
    );
    await db.exec(
      `select public.delete_chain_step('33333333-3333-4333-8333-333333333333','${step2.id}')`,
    );
    let remaining = await query(
      `select * from public.prompt_chain_steps where chain_id='33333333-3333-4333-8333-333333333333'`,
    );
    assert(
      remaining.length === 1 &&
        remaining[0].id === step1.id &&
        remaining[0].position === 0,
      "delete compacts positions",
    );
    await db.exec(
      `insert into storage.objects(bucket_id,name) values('prompt-chain-media','admin.png')`,
    );
    assert(true, "superadmin can store generated image");
    await db.exec(
      `set request.jwt.claim.sub='22222222-2222-4222-8222-222222222222';`,
    );
    assert(
      (await query(`select * from public.prompt_chains`)).length === 0,
      "ordinary user cannot list chains",
    );
    assert(
      (await query(`select * from public.prompt_chain_steps`)).length === 0,
      "ordinary user cannot list steps",
    );
    assert(
      (
        await query(
          `select * from storage.objects where bucket_id='prompt-chain-media'`,
        )
      ).length === 0,
      "ordinary user cannot list generated media",
    );
    await db.exec(
      `reset role; set role anon; set request.jwt.claim.role='anon'; set request.jwt.claim.sub='';`,
    );
    assert(
      (
        await query(
          `select * from storage.objects where bucket_id='prompt-chain-media'`,
        )
      ).length === 0,
      "anonymous storage read denied despite legacy policy",
    );
    await db.exec(
      `reset role; set request.jwt.claim.role=''; update public.profiles set is_superadmin=true where id='22222222-2222-4222-8222-222222222222';`,
    );
    assert(true, "trusted SQL administrator can assign superadmin");
    expect(passed).toBe(21);
  } finally {
    await db.close();
  }
}, 30000);
