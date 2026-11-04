import { describe, expect, it, vi } from "vitest";
import { listLegacyHistory } from "../lib/legacy-history";
const chain = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const item = {
  source: "saved_example",
  id,
  chain_id: chain,
  created_at: "2026-11-04T00:00:00Z",
  prompt: "Describe",
  status: "saved",
  output: "A cat",
  title: null,
  caption: null,
  model: null,
  origin: null,
  generation_prompt: null,
  generation_status: null,
  truncated: false,
};
const db = (data: unknown, error: null | { code: string } = null) => ({
  rpc: vi.fn().mockResolvedValue({ data, error }),
});
describe("read-only saved history projection", () => {
  it("accepts only the explicit text/history fields", async () => {
    const database = db([
      { ...item, private_media_url: "https://private.example/image" },
    ]);
    expect(await listLegacyHistory(database, chain)).toEqual([item]);
    expect(database.rpc).toHaveBeenCalledWith("chainlab_list_legacy_history", {
      p_chain_id: chain,
    });
  });
  it("keeps identical UUIDs from separate legacy sources distinct", async () => {
    const request = {
      ...item,
      source: "generation_request",
      output: null,
      status: "queued",
    };
    expect(await listLegacyHistory(db([item, request]), chain)).toHaveLength(2);
    await expect(
      listLegacyHistory(db([item, item]), chain),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("rejects another chain and incompatible data", async () => {
    await expect(
      listLegacyHistory(db([{ ...item, chain_id: id }]), chain),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      listLegacyHistory(db([{ ...item, truncated: undefined }]), chain),
    ).rejects.toMatchObject({ status: 503 });
    await expect(listLegacyHistory(db(null), chain)).rejects.toMatchObject({
      status: 503,
    });
  });
  it("denies authorization failures and reports missing setup safely", async () => {
    await expect(
      listLegacyHistory(db(null, { code: "42501" }), chain),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      listLegacyHistory(db(null, { code: "PGRST202" }), chain),
    ).rejects.toMatchObject({ status: 503 });
  });
});
