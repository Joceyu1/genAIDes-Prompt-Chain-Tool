import { describe, expect, it, vi } from "vitest";
import {
  getRegistryModels,
  getRegistryModelsForEditing,
} from "../lib/model-registry";
const id = "11111111-1111-4111-8111-111111111111";
const record = {
  id,
  label: "GPT 4.1 mini",
  model: "gpt-4.1-mini",
  provider: "openai",
  active: true,
  kind: "text",
};
const database = (data: unknown, error: { code: string } | null = null) => ({
  rpc: vi.fn().mockResolvedValue({ data, error }),
});
describe("model registry boundary", () => {
  it("loads only guarded choices and excludes unrelated fields", async () => {
    const db = database([
      {
        ...record,
        api_key: "fixture-not-a-real-key",
        provider_configuration: { private: "fixture" },
      },
    ]);
    const rows = await getRegistryModels(db);
    expect(db.rpc).toHaveBeenCalledWith("chainlab_list_models");
    expect(rows).toEqual([record]);
    expect(rows[0]).not.toHaveProperty("api_key");
    expect(rows[0]).not.toHaveProperty("provider_configuration");
  });
  it("preserves inactive or unresolved provider models without guessing a replacement", async () => {
    const rows = await getRegistryModels(
      database([
        {
          ...record,
          model: "provider-specific-model",
          provider: "",
          active: false,
          kind: null,
        },
      ]),
    );
    expect(rows[0]).toEqual({
      ...record,
      model: "provider-specific-model",
      provider: "",
      active: false,
      kind: undefined,
    });
  });
  it.each([
    { reason: "duplicate IDs", data: [record, record] },
    { reason: "invalid IDs", data: [{ ...record, id: "invalid" }] },
    { reason: "invalid active flags", data: [{ ...record, active: "true" }] },
  ])("rejects $reason", async ({ data }) => {
    await expect(getRegistryModels(database(data))).rejects.toMatchObject({
      status: 503,
    });
  });
  it("allows editing with unresolved model IDs during outages without swallowing permission denials", async () => {
    expect(
      await getRegistryModelsForEditing(database(null, { code: "PGRST202" })),
    ).toEqual([]);
    await expect(
      getRegistryModelsForEditing(database(null, { code: "42501" })),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("keeps missing setup and revoked permissions distinct", async () => {
    await expect(
      getRegistryModels(database(null, { code: "PGRST202" })),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      getRegistryModels(database(null, { code: "42501" })),
    ).rejects.toMatchObject({ status: 403 });
  });
});
