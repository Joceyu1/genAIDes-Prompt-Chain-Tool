import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildApplyQuery,
  INSPECT_SQL,
  managementQuery,
  preflight,
  PROJECT_REF,
} from "../scripts/configure-supabase.mjs";
const fresh = () => ({
  prerequisites: {
    auth_users: true,
    storage_buckets: true,
    storage_objects: true,
  },
  tables: [
    {
      name: "profiles",
      id_unique: true,
      safe_admin_default: true,
      columns: [
        { name: "id", type: "uuid", not_null: true },
        { name: "is_superadmin", type: "boolean", not_null: false },
      ],
    },
  ],
  functions: [],
  policies: [],
  triggers: [],
  bucket: null,
});
afterEach(() => vi.unstubAllGlobals());
describe("shared Supabase migration preflight", () => {
  it("permits compatible existing profiles without adopting app objects", () => {
    expect(preflight(fresh())).toEqual([]);
    expect(preflight({ ...fresh(), tables: [] })).toEqual([]);
  });
  it("fails closed for incomplete metadata and incompatible profile IDs or roles", () => {
    expect(preflight(null)).not.toEqual([]);
    expect(preflight({ ...fresh(), functions: undefined })).not.toEqual([]);
    expect(
      preflight({
        ...fresh(),
        tables: [
          {
            name: "profiles",
            id_unique: false,
            columns: [{ name: "id", type: "text", not_null: true }],
          },
        ],
      }),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("non-null UUID")]),
    );
    expect(
      preflight({
        ...fresh(),
        tables: [
          {
            ...fresh().tables[0],
            safe_admin_default: false,
            columns: [
              { name: "id", type: "uuid", not_null: true },
              { name: "is_superadmin", type: "text" },
            ],
          },
        ],
      }),
    ).toHaveLength(2);
  });
  it("refuses existing app tables, helpers and bucket even if they appear compatible", () => {
    expect(
      preflight({
        ...fresh(),
        tables: [...fresh().tables, { name: "prompt_chains" }],
        functions: [{ name: "append_chain_step" }],
        bucket: { id: "prompt-chain-media" },
      }),
    ).toHaveLength(3);
    expect(
      preflight({
        ...fresh(),
        policies: [{ name: "prompt_chain_read_own_profile" }],
        triggers: [{ name: "guard_prompt_chain_superadmin_role" }],
      }),
    ).toHaveLength(2);
  });
  it("wraps the reviewed SQL in a guarded single transaction with no object replacement on collisions", () => {
    const migration = readFileSync(
      new URL(
        "../supabase/migrations/20261102000000_prompt_chains.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const query = buildApplyQuery(migration);
    expect(query.startsWith("begin;")).toBe(true);
    expect(query.endsWith("commit;")).toBe(true);
    expect(query.match(/^begin;\s*$/gm)).toHaveLength(1);
    expect(query.match(/^commit;\s*$/gm)).toHaveLength(1);
    expect(query.indexOf("App object collision detected")).toBeLessThan(
      query.indexOf("create table if not exists public.profiles"),
    );
    expect(() => buildApplyQuery("create table example(id int)")).toThrow(
      "transaction format changed",
    );
  });
  it("uses only schema metadata and fixes the Management API destination and project", async () => {
    expect(INSPECT_SQL).not.toMatch(
      /select\s+\*\s+from\s+(auth\.users|public\.profiles)/i,
    );
    const mock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ inspection: fresh() }])),
      );
    vi.stubGlobal("fetch", mock);
    await managementQuery(INSPECT_SQL, true, "unit-test-token");
    expect(mock.mock.calls[0][0]).toBe(
      `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    );
    expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual({
      query: INSPECT_SQL,
      read_only: true,
    });
  });
  it("never includes provider response bodies or credentials in reported HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("secret-token-response", { status: 403 }),
        ),
    );
    await expect(
      managementQuery("select 1", true, "unit-test-token"),
    ).rejects.toThrow("HTTP 403");
    await expect(managementQuery("select 1", true, "")).rejects.toThrow(
      "SUPABASE_ACCESS_TOKEN is missing",
    );
  });
});
