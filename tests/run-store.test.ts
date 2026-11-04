import { describe, expect, it, vi } from "vitest";
import { createRun, listRuns, updateRun } from "../lib/run-store";
const chain = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const step = "33333333-3333-4333-8333-333333333333";
const run = {
  id,
  chain_id: chain,
  status: "running" as const,
  input: "Input",
  outputs: [],
  error: null,
  created_at: "2026-11-04T00:00:00Z",
};
const database = (data: unknown, error: { code: string } | null = null) => ({
  rpc: vi.fn().mockResolvedValue({ data, error }),
});
describe("typed history RPC store", () => {
  it("accepts composite object or single-row responses without exposing extra fields", async () => {
    for (const value of [run, [{ ...run, created_by: "hidden" }]]) {
      const db = database(value);
      expect(await createRun(db, chain, "Input")).toEqual(run);
      expect(db.rpc).toHaveBeenCalledWith("chainlab_create_run", {
        p_chain_id: chain,
        p_input: "Input",
      });
    }
  });
  it("rejects another chain, duplicate history, and invalid result shapes", async () => {
    await expect(
      listRuns(database([{ ...run, chain_id: id }]), chain),
    ).rejects.toMatchObject({ status: 503 });
    await expect(listRuns(database([run, run]), chain)).rejects.toMatchObject({
      status: 503,
    });
    await expect(
      createRun(database({ id }), chain, "Input"),
    ).rejects.toMatchObject({ status: 503 });
    await expect(listRuns(database(null), chain)).rejects.toMatchObject({
      status: 503,
    });
  });
  it("rejects public URLs and foreign image paths before signing media", async () => {
    const image = {
      step_id: step,
      step_name: "Draw",
      kind: "image",
      content: "",
      image_path: `${chain}/${id}/${step}.png`,
    };
    expect(
      (await listRuns(database([{ ...run, outputs: [image] }]), chain))[0]
        .outputs,
    ).toEqual([image]);
    for (const output of [
      { ...image, content: "https://public.example/image.png" },
      { ...image, image_path: "other/private.png" },
      { ...image, kind: "text", content: "Text" },
    ]) {
      await expect(
        listRuns(database([{ ...run, outputs: [output] }]), chain),
      ).rejects.toMatchObject({ status: 503 });
    }
  });
  it("sends run identifiers and sanitizes missing-setup and terminal-state errors", async () => {
    const db = database({
      ...run,
      status: "failed",
      error: "Provider unavailable",
    });
    await updateRun(db, run, "failed", [], "Provider unavailable");
    expect(db.rpc).toHaveBeenCalledWith("chainlab_update_run", {
      p_run_id: id,
      p_status: "failed",
      p_outputs: [],
      p_error: "Provider unavailable",
    });
    await expect(
      updateRun(database(null, { code: "55000" }), run, "running", []),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      listRuns(database(null, { code: "PGRST202" }), chain),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      listRuns(database(null, { code: "42501" }), chain),
    ).rejects.toMatchObject({ status: 403 });
  });
});
