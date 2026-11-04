import { describe, expect, it, vi } from "vitest";
import {
  appendStep,
  createChain,
  deleteChain,
  deleteStep,
  getChain,
  listChains,
  reorderSteps,
  updateChain,
  updateStep,
} from "../lib/chain-store";
import { chainExists, type supabaseServer } from "../lib/server";

const chain = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Shared chain",
  description: "Existing assignment data",
  is_active: true,
  source: "source_snapshot",
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-11-04T12:00:00Z",
};
const step = {
  id: "22222222-2222-4222-8222-222222222222",
  chain_id: chain.id,
  position: 2,
  role: "system",
  template: "Describe {{input}}",
  model_id: "33333333-3333-4333-8333-333333333333",
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-11-04T12:00:00Z",
};
const settings = {
  step_id: step.id,
  name: "Describe",
  kind: "text" as const,
  fallback_model: "gpt-4.1-mini",
};
const snapshot = () => ({ chain, steps: [step], settings: [settings] });
const database = (data: unknown = snapshot()) => ({
  rpc: vi.fn().mockResolvedValue({ data, error: null }),
});

describe("shared-schema chain RPC store", () => {
  it("lists and adapts actual table rows without direct table reads or substituting registry UUIDs", async () => {
    const secondChain = {
      ...chain,
      id: "44444444-4444-4444-8444-444444444444",
      name: "Inactive chain",
      is_active: false,
    };
    const firstStep = {
      ...step,
      id: "55555555-5555-4555-8555-555555555555",
      position: 1,
      role: "assistant",
      model_id: null,
    };
    const db = database({
      chains: [chain, secondChain],
      steps: [step, firstStep],
      settings: [settings],
    });
    const result = await listChains(db);
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("chainlab_list_chains");
    expect(result).toMatchObject([
      {
        id: chain.id,
        status: "active",
        source: "source_snapshot",
        steps: [
          {
            position: 1,
            role: "assistant",
            model_id: null,
            generation_ready: true,
          },
          {
            position: 2,
            role: "system",
            model_id: step.model_id,
            model: "",
            generation_ready: false,
          },
        ],
      },
      { id: secondChain.id, status: "draft", steps: [] },
    ]);
  });

  it("resolves models only from an explicitly supplied registry context", async () => {
    const db = database();
    const result = await getChain(db, chain.id, {
      models: [
        {
          id: step.model_id,
          label: "Assigned GPT",
          model: "gpt-4.1",
          provider: "openai",
        },
      ],
    });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("chainlab_get_chain", {
      p_id: chain.id,
    });
    expect(result.steps[0]).toMatchObject({
      model_id: step.model_id,
      model: "gpt-4.1",
      generation_ready: true,
    });
  });

  it("creates chains using is_active without writing source, status or created_by", async () => {
    const db = database();
    const result = await createChain(db, {
      name: chain.name,
      description: chain.description,
      status: "draft",
    });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("chainlab_create_chain", {
      p_name: chain.name,
      p_description: chain.description,
      p_is_active: false,
    });
    expect(result.source).toBe("source_snapshot");
  });

  it("updates only supplied chain fields while preserving source", async () => {
    const db = database();
    const result = await updateChain(db, chain.id, {
      name: "Renamed",
      status: "active",
    });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("chainlab_update_chain", {
      p_id: chain.id,
      p_patch: { name: "Renamed", is_active: true },
    });
    expect(result.source).toBe(chain.source);
  });

  it("defaults a new step's role and nullable registry assignment without confusing provider model strings", async () => {
    const db = database({
      step: { ...step, role: "user", model_id: null },
      settings,
    });
    const result = await appendStep(db, chain.id, {
      name: "Describe",
      prompt: "Describe {{input}}",
      kind: "text",
      model: "gpt-4.1-mini",
    });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("chainlab_append_step", {
      p_chain_id: chain.id,
      p_step: { role: "user", template: "Describe {{input}}", model_id: null },
      p_settings: {
        name: "Describe",
        kind: "text",
        fallback_model: "gpt-4.1-mini",
      },
    });
    expect(result).toMatchObject({
      model_id: null,
      model: "gpt-4.1-mini",
      generation_ready: true,
    });
  });

  it("keeps omitted role and model_id out of an update, preserving assigned registry data", async () => {
    const db = database({ step, settings });
    const result = await updateStep(db, chain.id, step.id, {
      name: "Renamed",
      prompt: "New template",
      kind: "text",
      model: "unresolved-provider-model",
    });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("chainlab_update_step", {
      p_chain_id: chain.id,
      p_step_id: step.id,
      p_step: { template: "New template" },
      p_settings: {
        name: "Renamed",
        kind: "text",
        fallback_model: "unresolved-provider-model",
      },
    });
    expect(result).toMatchObject({
      role: "system",
      model_id: step.model_id,
      model: "",
      generation_ready: false,
    });
  });

  it("sends an explicit null model_id and a deliberate role change faithfully", async () => {
    const db = database({
      step: { ...step, role: "assistant", model_id: null },
      settings,
    });
    await updateStep(db, chain.id, step.id, {
      model_id: null,
      role: "assistant",
    });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("chainlab_update_step", {
      p_chain_id: chain.id,
      p_step_id: step.id,
      p_step: { model_id: null, role: "assistant" },
      p_settings: {},
    });
  });

  it("returns the canonical steps from an atomic reorder snapshot", async () => {
    const db = database();
    const ids = Object.freeze([step.id]);
    const result = await reorderSteps(db, chain.id, ids);
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("chainlab_reorder_steps", {
      p_chain_id: chain.id,
      p_step_ids: [step.id],
    });
    expect(result.steps[0]).toMatchObject({
      id: step.id,
      position: 2,
      prompt: step.template,
    });
    expect(ids).toEqual([step.id]);
  });

  it("deletes chains and steps through their scoped RPCs", async () => {
    const db = database(null);
    await deleteStep(db, chain.id, step.id);
    await deleteChain(db, chain.id);
    expect(db.rpc.mock.calls).toEqual([
      ["chainlab_delete_step", { p_chain_id: chain.id, p_step_id: step.id }],
      ["chainlab_delete_chain", { p_id: chain.id }],
    ]);
  });

  it("explains reference-restricted chain deletion without exposing raw database errors", async () => {
    const db = database();
    db.rpc.mockResolvedValue({
      data: null,
      error: { code: "23503", message: "private media details" },
    });
    await expect(deleteChain(db, chain.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Draft to deactivate"),
    });
    await expect(
      updateStep(db, chain.id, step.id, { model_id: chain.id }),
    ).rejects.toMatchObject({
      status: 409,
      message:
        "A referenced record is missing or still in use. Refresh and try again.",
    });
  });

  it("explains duplicate chain names while preserving other uniqueness errors", async () => {
    const db = database();
    db.rpc.mockResolvedValue({
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "prompt_chains_name_key"',
      },
    });
    await expect(
      createChain(db, {
        name: "Shared chain",
        description: "",
        status: "draft",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "A chain with this name already exists.",
    });
    db.rpc.mockResolvedValue({
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "prompt_chain_steps_chain_id_position_key"',
      },
    });
    await expect(getChain(db, chain.id)).rejects.toMatchObject({
      status: 409,
      message:
        "This data changed while you were editing. Refresh and try again.",
    });
  });

  it.each([
    ["23001", 409],
    ["23503", 409],
    ["23505", 409],
    ["P0002", 404],
    ["22023", 400],
    ["23514", 400],
    ["42501", 403],
    ["PGRST202", 503],
    ["42883", 503],
  ])("maps database error %s to HTTP %i", async (code, status) => {
    const db = database();
    db.rpc.mockResolvedValue({
      data: null,
      error: { code, message: "sensitive database data" },
    });
    await expect(getChain(db, chain.id)).rejects.toMatchObject({ status });
    await expect(getChain(db, chain.id)).rejects.not.toThrow(
      "sensitive database data",
    );
  });

  it("fails clearly on missing, incompatible or mismatched RPC data", async () => {
    await expect(getChain(database(null), chain.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      getChain(
        database({
          chain,
          steps: [{ ...step, template: undefined }],
          settings: [],
        }),
        chain.id,
      ),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      getChain(
        database({ ...snapshot(), chain: { ...chain, id: step.id } }),
        chain.id,
      ),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      updateStep(
        database({ step, settings: { ...settings, step_id: chain.id } }),
        chain.id,
        step.id,
        { prompt: "Changed" },
      ),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      updateStep(
        database({ step: { ...step, id: chain.id }, settings: null }),
        chain.id,
        step.id,
        { prompt: "Changed" },
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("checks chain existence using the same superadmin-scoped RPC", async () => {
    const db = database();
    await chainExists(
      db as unknown as Awaited<ReturnType<typeof supabaseServer>>,
      chain.id,
    );
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("chainlab_get_chain", {
      p_id: chain.id,
    });
    const missing = database(null);
    await expect(
      chainExists(
        missing as unknown as Awaited<ReturnType<typeof supabaseServer>>,
        chain.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("explains the full-position reorder limit without exposing arbitrary database errors", async () => {
    const db = database();
    const message =
      "Reordering 1000 occupied positions needs a free slot; remove a step first";
    db.rpc.mockResolvedValue({ data: null, error: { code: "22023", message } });
    await expect(reorderSteps(db, chain.id, [step.id])).rejects.toMatchObject({
      status: 400,
      message,
    });
  });
});
