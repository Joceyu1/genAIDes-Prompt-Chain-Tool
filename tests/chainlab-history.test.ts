import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const admin = "11111111-1111-4111-8111-111111111111";
const otherAdmin = "22222222-2222-4222-8222-222222222222";
const member = "33333333-3333-4333-8333-333333333333";
const chain = "44444444-4444-4444-8444-444444444444";
const step = "55555555-5555-4555-8555-555555555555";
const historySQL = readFileSync(
  new URL(
    "../supabase/migrations/20261104030000_chainlab_history.sql",
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
create role authenticated;create role anon;create schema auth;create schema storage;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth,storage to authenticated,anon;
create table public.profiles(id uuid primary key references auth.users(id),is_superadmin boolean not null default false);
alter table public.profiles enable row level security;grant select on public.profiles to authenticated;
create function public.is_columbia_google_user() returns boolean language sql stable as $$select false$$;
create policy columbia_profiles_guard on public.profiles as restrictive for all to authenticated using((select public.is_columbia_google_user()));
create policy own_profile_read on public.profiles for select to authenticated using(id=auth.uid());
insert into auth.users values('${admin}'),('${otherAdmin}'),('${member}');
insert into public.profiles values('${admin}',true),('${otherAdmin}',true),('${member}',false);
create table public.prompt_chains(id uuid primary key,name text,source text not null default 'source_snapshot');
insert into public.prompt_chains values('${chain}','Existing chain','source_snapshot');
alter table public.prompt_chains enable row level security;
create table public.generation_requests(id uuid primary key default gen_random_uuid(),chain_id uuid references public.prompt_chains(id) on delete restrict,prompt text,status text);
insert into public.generation_requests(chain_id,prompt,status) values('${chain}','Existing prompt','completed');
create table public.ai_generation_examples(id uuid primary key default gen_random_uuid(),chain_id uuid references public.prompt_chains(id) on delete restrict,prompt text,output text);
insert into public.ai_generation_examples(chain_id,prompt,output) values('${chain}','Existing example','Existing output');
create table storage.buckets(id text primary key,name text unique,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
alter table storage.objects enable row level security;
grant select,insert,delete on storage.objects to authenticated;
insert into storage.buckets values('existing-media','existing-media',false,null,null);
insert into storage.objects(bucket_id,name) values('existing-media','original.png');
create policy columbia_storage_guard on storage.objects as restrictive for all to authenticated using((select public.is_columbia_google_user())) with check((select public.is_columbia_google_user()));
`;
type Run = {
  id: string;
  chain_id: string;
  created_by: string;
  status: string;
  outputs: unknown[];
  error: string | null;
};
async function rpc<T>(
  db: PGlite,
  name: string,
  args: unknown[] = [],
): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(",");
  return (
    await db.query<{ result: T }>(
      `select to_jsonb(public.${name}(${placeholders})) as result`,
      args,
    )
  ).rows[0].result;
}
async function setup() {
  const db = new PGlite();
  await db.exec(bootstrap);
  await db.exec(authSQL);
  await db.exec(historySQL);
  await db.exec(asUser(admin));
  return db;
}
const textOutput = {
  step_id: step,
  step_name: "Describe",
  kind: "text",
  content: "A cat",
};
describe("private Chainlab history in the shared assignment database", () => {
  it("allows the real existing admin through RPCs while profile RLS remains restrictive", async () => {
    const db = await setup();
    try {
      expect((await db.query("select * from public.profiles")).rows).toEqual(
        [],
      );
      const run = await rpc<Run>(db, "chainlab_create_run", [
        chain,
        "Image of a cat",
      ]);
      expect(run).toMatchObject({
        chain_id: chain,
        created_by: admin,
        status: "running",
        outputs: [],
      });
      await rpc(db, "chainlab_update_run", [
        run.id,
        "running",
        JSON.stringify([textOutput]),
        null,
      ]);
      const complete = await rpc<Run>(db, "chainlab_update_run", [
        run.id,
        "completed",
        JSON.stringify([textOutput]),
        null,
      ]);
      expect(complete.status).toBe("completed");
      expect(
        (await db.query("select * from public.chainlab_list_runs($1)", [chain]))
          .rows,
      ).toHaveLength(1);
      await expect(
        db.query("select * from public.chainlab_runs"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query(
          "insert into public.chainlab_runs(chain_id,created_by,input) values($1,$2,'bypass')",
          [chain, admin],
        ),
      ).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
      expect(
        (await db.query("select source from public.prompt_chains")).rows,
      ).toEqual([{ source: "source_snapshot" }]);
      expect(
        (await db.query("select prompt,status from public.generation_requests"))
          .rows,
      ).toEqual([{ prompt: "Existing prompt", status: "completed" }]);
      expect(
        (
          await db.query(
            "select prompt,output from public.ai_generation_examples",
          )
        ).rows,
      ).toEqual([{ prompt: "Existing example", output: "Existing output" }]);
      expect((await db.query("select name from storage.objects")).rows).toEqual(
        [{ name: "original.png" }],
      );
      expect(
        (
          await db.query(
            "select public from storage.buckets where id='chainlab-generated-media'",
          )
        ).rows,
      ).toEqual([{ public: false }]);
    } finally {
      await db.close();
    }
  });
  it("denies every history entry point to members and anonymous callers", async () => {
    const db = await setup();
    try {
      const run = await rpc<Run>(db, "chainlab_create_run", [chain, "Input"]);
      const operations = [
        () => rpc(db, "chainlab_list_runs", [chain]),
        () => rpc(db, "chainlab_create_run", [chain, "Denied"]),
        () =>
          rpc(db, "chainlab_update_run", [run.id, "failed", "[]", "Denied"]),
      ];
      await db.exec(asUser(member));
      for (const operation of operations)
        await expect(operation()).rejects.toThrow(/Superadmin access required/);
      await db.exec("reset role;set role anon;set request.jwt.claim.sub='';");
      for (const operation of operations)
        await expect(operation()).rejects.toThrow(/permission denied/);
    } finally {
      await db.close();
    }
  });
  it("permits admin history reads but only its creator can write a run", async () => {
    const db = await setup();
    try {
      const run = await rpc<Run>(db, "chainlab_create_run", [chain, "Input"]);
      await db.exec(asUser(otherAdmin));
      expect(
        (await db.query("select * from public.chainlab_list_runs($1)", [chain]))
          .rows,
      ).toHaveLength(1);
      await expect(
        rpc(db, "chainlab_update_run", [
          run.id,
          "failed",
          "[]",
          "Wrong author",
        ]),
      ).rejects.toThrow(/Only the run creator/);
    } finally {
      await db.close();
    }
  });
  it("keeps partial outputs immutable and refuses to reopen a finished run", async () => {
    const db = await setup();
    try {
      const run = await rpc<Run>(db, "chainlab_create_run", [chain, "Input"]);
      const outputs = JSON.stringify([textOutput]);
      await rpc(db, "chainlab_update_run", [run.id, "running", outputs, null]);
      await expect(
        rpc(db, "chainlab_update_run", [run.id, "running", "[]", null]),
      ).rejects.toThrow(/cannot be replaced/);
      await rpc(db, "chainlab_update_run", [
        run.id,
        "failed",
        outputs,
        "Provider unavailable",
      ]);
      await expect(
        rpc(db, "chainlab_update_run", [run.id, "running", outputs, null]),
      ).rejects.toThrow(/cannot be changed or reopened/);
      expect(
        await rpc<Run>(db, "chainlab_update_run", [
          run.id,
          "failed",
          outputs,
          "Provider unavailable",
        ]),
      ).toMatchObject({ status: "failed", outputs: [textOutput] });
    } finally {
      await db.close();
    }
  });
  it("stores only run-scoped private image paths and validates status/output shape", async () => {
    const db = await setup();
    try {
      const run = await rpc<Run>(db, "chainlab_create_run", [chain, "Input"]);
      const image = {
        ...textOutput,
        kind: "image",
        content: "",
        image_path: `${chain}/${run.id}/${step}.png`,
      };
      for (const output of [
        { ...image, content: "https://public.example/image.png" },
        { ...image, image_path: "existing-media/original.png" },
        { ...image, image_path: "../other-run.png" },
        { ...textOutput, step_id: "nope" },
      ]) {
        await expect(
          rpc(db, "chainlab_update_run", [
            run.id,
            "completed",
            JSON.stringify([output]),
            null,
          ]),
        ).rejects.toThrow(/private storage path|Invalid step output/);
      }
      await expect(
        rpc(db, "chainlab_update_run", [run.id, "completed", "[]", null]),
      ).rejects.toThrow(/Invalid run result/);
      await expect(
        rpc(db, "chainlab_update_run", [run.id, "failed", "[]", null]),
      ).rejects.toThrow(/Invalid run result/);
      expect(
        await rpc<Run>(db, "chainlab_update_run", [
          run.id,
          "completed",
          JSON.stringify([image]),
          null,
        ]),
      ).toMatchObject({ status: "completed", outputs: [image] });
    } finally {
      await db.close();
    }
  });
  it("returns at most the latest 50 runs with stable ordering", async () => {
    const db = await setup();
    try {
      await db.exec("reset role");
      await db.query(
        "insert into public.chainlab_runs(chain_id,created_by,input,created_at) select $1,$2,'Input',now()+i*interval '1 second' from generate_series(1,55) i",
        [chain, admin],
      );
      await db.exec(asUser(admin));
      const { rows } = await db.query<{ created_at: Date }>(
        "select * from public.chainlab_list_runs($1)",
        [chain],
      );
      expect(rows).toHaveLength(50);
      expect(new Date(rows[0].created_at).getTime()).toBeGreaterThan(
        new Date(rows[49].created_at).getTime(),
      );
    } finally {
      await db.close();
    }
  });
  it("preserves restrictive storage guards and original bucket permissions", async () => {
    const db = await setup();
    try {
      expect((await db.query("select * from storage.objects")).rows).toEqual(
        [],
      );
      await expect(
        db.query(
          "insert into storage.objects(bucket_id,name) values('chainlab-generated-media','probe.png')",
        ),
      ).rejects.toThrow(/row-level security/);
      await db.exec("reset role");
      expect(
        (
          await db.query(
            "select permissive from pg_policies where policyname='columbia_storage_guard'",
          )
        ).rows,
      ).toEqual([{ permissive: "RESTRICTIVE" }]);
      const functions = (
        await db.query<{ prosecdef: boolean; proconfig: string[] }>(
          "select prosecdef,proconfig from pg_proc where proname in ('chainlab_list_runs','chainlab_create_run','chainlab_update_run')",
        )
      ).rows;
      expect(functions).toHaveLength(3);
      for (const fn of functions) {
        expect(fn.prosecdef).toBe(true);
        expect(fn.proconfig).toContain('search_path=""');
      }
    } finally {
      await db.close();
    }
  });
  it("allows the new private bucket alongside the existing avatar-only guards", async () => {
    const db = await setup();
    try {
      await db.exec(`reset role;
        drop policy columbia_storage_guard on storage.objects;
        insert into storage.buckets(id,name,public) values('avatars','avatars',false);
        create policy columbia_avatars_guard on storage.objects as restrictive for all to authenticated
          using(bucket_id<>'avatars' or public.is_columbia_google_user())
          with check(bucket_id<>'avatars' or public.is_columbia_google_user());
        create policy side_b_avatar_guard on storage.objects as restrictive for all to authenticated
          using(bucket_id<>'avatars' or false) with check(bucket_id<>'avatars' or false);
        create policy side_b_avatar_no_delete on storage.objects as restrictive for delete to authenticated
          using(bucket_id<>'avatars');
        create policy existing_avatar_access on storage.objects for all to authenticated
          using(bucket_id='avatars') with check(bucket_id='avatars');`);
      await db.exec(asUser(admin));
      await db.query(
        "insert into storage.objects(bucket_id,name) values('chainlab-generated-media','probe.png')",
      );
      expect((await db.query("select name from storage.objects")).rows).toEqual(
        [{ name: "probe.png" }],
      );
      await db.query("delete from storage.objects where name='probe.png'");
      expect((await db.query("select name from storage.objects")).rows).toEqual(
        [],
      );
      await expect(
        db.query(
          "insert into storage.objects(bucket_id,name) values('avatars','blocked.png')",
        ),
      ).rejects.toThrow(/row-level security/);
      await db.exec(asUser(member));
      await expect(
        db.query(
          "insert into storage.objects(bucket_id,name) values('chainlab-generated-media','blocked.png')",
        ),
      ).rejects.toThrow(/row-level security/);
      await db.exec("reset role");
      expect((await db.query("select name from storage.objects")).rows).toEqual(
        [{ name: "original.png" }],
      );
    } finally {
      await db.close();
    }
  });
  it("keeps the new bucket admin-only even alongside broad existing public policies", async () => {
    const db = new PGlite();
    try {
      await db.exec(bootstrap);
      await db.exec(authSQL);
      await db.exec(`drop policy columbia_storage_guard on storage.objects;
        grant select,insert,update,delete on storage.objects to authenticated,anon;
        create policy existing_broad_access on storage.objects for all to public using(true) with check(true);`);
      const authAcl = (
        await db.query(
          "select proacl::text as acl from pg_proc where proname='chainlab_is_superadmin'",
        )
      ).rows;
      const broadPolicy = (
        await db.query(
          "select permissive,roles,cmd,qual,with_check from pg_policies where policyname='existing_broad_access'",
        )
      ).rows;
      await db.exec(historySQL);
      expect(
        (
          await db.query(
            "select proacl::text as acl from pg_proc where proname='chainlab_is_superadmin'",
          )
        ).rows,
      ).toEqual(authAcl);
      expect(
        (
          await db.query(
            "select permissive,roles,cmd,qual,with_check from pg_policies where policyname='existing_broad_access'",
          )
        ).rows,
      ).toEqual(broadPolicy);
      expect(
        (
          await db.query(
            "select has_function_privilege('anon','public.chainlab_is_superadmin()','EXECUTE') as allowed",
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
      expect(
        (
          await db.query(
            "select prosecdef,provolatile,proconfig from pg_proc where proname='chainlab_can_access_media'",
          )
        ).rows,
      ).toEqual([
        { prosecdef: true, provolatile: "s", proconfig: ['search_path=""'] },
      ]);
      await db.exec(asUser(admin));
      expect(
        (await db.query("select public.chainlab_can_access_media() as allowed"))
          .rows,
      ).toEqual([{ allowed: true }]);
      await db.query(
        "insert into storage.objects(bucket_id,name) values('chainlab-generated-media','private.png')",
      );
      expect(
        (await db.query("select name from storage.objects order by name")).rows,
      ).toEqual([{ name: "original.png" }, { name: "private.png" }]);
      for (const identity of ["member", "anon"]) {
        await db.exec(
          identity === "member"
            ? asUser(member)
            : "reset role;set role anon;set request.jwt.claim.sub='';",
        );
        expect(
          (
            await db.query(
              "select public.chainlab_can_access_media() as allowed",
            )
          ).rows,
        ).toEqual([{ allowed: false }]);
        expect(
          (
            await db.query(
              "select name from storage.objects where bucket_id='chainlab-generated-media'",
            )
          ).rows,
        ).toEqual([]);
        await expect(
          db.query(
            "insert into storage.objects(bucket_id,name) values('chainlab-generated-media','denied.png')",
          ),
        ).rejects.toThrow(/row-level security/);
        expect(
          (
            await db.query(
              "update storage.objects set name='changed.png' where bucket_id='chainlab-generated-media' returning name",
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await db.query(
              "delete from storage.objects where bucket_id='chainlab-generated-media' returning name",
            )
          ).rows,
        ).toEqual([]);
        // Other buckets keep the original broad policy, including anonymous callers.
        await db.query(
          "insert into storage.objects(bucket_id,name) values('existing-media',$1)",
          [`${identity}.png`],
        );
        expect(
          (
            await db.query(
              "update storage.objects set name=$1 where name=$2 returning name",
              [`${identity}-changed.png`, `${identity}.png`],
            )
          ).rows,
        ).toEqual([{ name: `${identity}-changed.png` }]);
        expect(
          (
            await db.query(
              "delete from storage.objects where name=$1 returning name",
              [`${identity}-changed.png`],
            )
          ).rows,
        ).toEqual([{ name: `${identity}-changed.png` }]);
        expect(
          (await db.query("select name from storage.objects")).rows,
        ).toEqual([{ name: "original.png" }]);
      }
      await expect(
        db.query("select public.chainlab_is_superadmin()"),
      ).rejects.toThrow(/permission denied/);
      await db.exec(asUser(admin));
      expect(
        (
          await db.query(
            "delete from storage.objects where bucket_id='chainlab-generated-media' returning name",
          )
        ).rows,
      ).toEqual([{ name: "private.png" }]);
    } finally {
      await db.close();
    }
  });
  it.each(["helper", "policy"])(
    "aborts without adopting an existing media %s",
    async (collision) => {
      const db = new PGlite();
      try {
        await db.exec(bootstrap);
        await db.exec(authSQL);
        if (collision === "helper")
          await db.exec(
            "create function public.chainlab_can_access_media() returns boolean language sql as $$select false$$;",
          );
        else
          await db.exec(
            "create policy chainlab_generated_media_guard on storage.objects as restrictive for all to public using(false);",
          );
        await expect(db.exec(historySQL)).rejects.toThrow(/already exists/);
        await db.exec("rollback");
        expect(
          (
            await db.query(
              "select to_regclass('public.chainlab_runs') as relation",
            )
          ).rows,
        ).toEqual([{ relation: null }]);
        if (collision === "helper")
          expect(
            (
              await db.query(
                "select public.chainlab_can_access_media() as allowed",
              )
            ).rows,
          ).toEqual([{ allowed: false }]);
        else
          expect(
            (
              await db.query(
                "select qual from pg_policies where policyname='chainlab_generated_media_guard'",
              )
            ).rows,
          ).toEqual([{ qual: "false" }]);
      } finally {
        await db.close();
      }
    },
  );
  it("aborts collisions atomically without adopting a pre-existing bucket", async () => {
    const db = new PGlite();
    try {
      await db.exec(bootstrap);
      await db.exec(authSQL);
      await db.exec(
        "insert into storage.buckets(id,name,public) values('chainlab-generated-media','chainlab-generated-media',true)",
      );
      await expect(db.exec(historySQL)).rejects.toThrow(
        /bucket already exists/,
      );
      await db.exec("rollback");
      expect(
        (
          await db.query(
            "select to_regclass('public.chainlab_runs') as relation",
          )
        ).rows,
      ).toEqual([{ relation: null }]);
      expect(
        (
          await db.query(
            "select public from storage.buckets where id='chainlab-generated-media'",
          )
        ).rows,
      ).toEqual([{ public: true }]);
    } finally {
      await db.close();
    }
  });
});
