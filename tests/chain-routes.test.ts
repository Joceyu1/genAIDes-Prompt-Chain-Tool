import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), models: vi.fn() }));
vi.mock("@/lib/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/server")>()),
  requireAdmin: mocks.auth,
}));
vi.mock("@/lib/model-registry", () => ({
  getRegistryModelsForEditing: mocks.models,
}));

import { GET as LIST, POST as CREATE } from "../app/api/chains/route";
import { GET, PATCH, DELETE } from "../app/api/chains/[id]/route";
import { POST as APPEND } from "../app/api/chains/[id]/steps/route";
import { PATCH as EDIT_STEP } from "../app/api/chains/[id]/steps/[stepId]/route";
import { PUT as ORDER } from "../app/api/chains/[id]/steps/order/route";
import { ApiError } from "../lib/server";

const chainId = "11111111-1111-4111-8111-111111111111";
const stepId = "22222222-2222-4222-8222-222222222222";
const modelId = "33333333-3333-4333-8333-333333333333";
const chain = {
  id: chainId,
  name: "Captions",
  description: "Shared",
  source: "source_snapshot",
  is_active: true,
  created_at: "2026-11-04T00:00:00Z",
  updated_at: "2026-11-04T00:00:00Z",
};
const step = {
  id: stepId,
  chain_id: chainId,
  position: 1,
  role: "system",
  template: "Describe it",
  model_id: modelId,
  created_at: chain.created_at,
  updated_at: chain.updated_at,
};
const settings = {
  step_id: stepId,
  name: "Describe",
  kind: "text",
  fallback_model: "gpt-4.1-mini",
};
const snapshot = { chain, steps: [step], settings: [settings] };
const context = () => ({ params: Promise.resolve({ id: chainId, stepId }) });
const request = (
  method: string,
  body?: unknown,
  origin = "https://app.example",
) =>
  new Request(`https://app.example/api/chains/${chainId}`, {
    method,
    headers: { origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const canonicalStep = {
  name: "Describe",
  prompt: "Describe it",
  kind: "text",
  model: "gpt-4.1-mini",
};

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.models.mockReset().mockResolvedValue([]);
});

describe("chain CRUD routes using the existing-schema bridge", () => {
  it("returns canonical list and individual chain responses from raw RPC snapshots", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: { chains: [chain], steps: [step], settings: [settings] },
        error: null,
      })
      .mockResolvedValueOnce({ data: snapshot, error: null });
    mocks.auth.mockResolvedValue({ db: { rpc }, user: { id: "admin" } });
    const list = await LIST(request("GET"), context());
    const single = await GET(request("GET"), context());
    expect(list.status).toBe(200);
    expect(single.status).toBe(200);
    expect((await list.json()).chains[0]).toMatchObject({
      status: "active",
      source: "source_snapshot",
      steps: [
        {
          prompt: "Describe it",
          role: "system",
          model_id: modelId,
          generation_ready: false,
        },
      ],
    });
    expect((await single.json()).chain.id).toBe(chainId);
    expect(list.headers.get("cache-control")).toBe("no-store");
  });

  it("creates and updates chains without invented columns", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: snapshot, error: null });
    mocks.auth.mockResolvedValue({ db: { rpc }, user: { id: "admin" } });
    expect(
      (
        await CREATE(
          request("POST", {
            name: "Captions",
            description: "Shared",
            status: "draft",
          }),
          context(),
        )
      ).status,
    ).toBe(201);
    expect(
      (await PATCH(request("PATCH", { status: "active" }), context())).status,
    ).toBe(200);
    expect(rpc.mock.calls).toEqual([
      [
        "chainlab_create_chain",
        { p_name: "Captions", p_description: "Shared", p_is_active: false },
      ],
      [
        "chainlab_update_chain",
        { p_id: chainId, p_patch: { is_active: true } },
      ],
    ]);
  });

  it("preserves an existing step's omitted model UUID and role during a full form edit", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { step, settings }, error: null });
    mocks.auth.mockResolvedValue({ db: { rpc }, user: { id: "admin" } });
    const response = await EDIT_STEP(
      request("PATCH", canonicalStep),
      context(),
    );
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("chainlab_update_step", {
      p_chain_id: chainId,
      p_step_id: stepId,
      p_step: { template: "Describe it" },
      p_settings: {
        name: "Describe",
        kind: "text",
        fallback_model: "gpt-4.1-mini",
      },
    });
    expect((await response.json()).step).toMatchObject({
      role: "system",
      model_id: modelId,
    });
  });

  it("resolves an assigned registry UUID to its provider key and label instead of the fallback model", async () => {
    mocks.models.mockResolvedValue([
      {
        id: modelId,
        label: "Assigned studio model",
        model: "gpt-4.1",
        provider: "openai",
        kind: "text",
        active: true,
      },
    ]);
    const rpc = vi.fn().mockResolvedValue({ data: snapshot, error: null });
    mocks.auth.mockResolvedValue({ db: { rpc }, user: { id: "admin" } });
    const response = await GET(request("GET"), context());
    expect(response.status).toBe(200);
    expect((await response.json()).chain.steps[0]).toMatchObject({
      model_id: modelId,
      model: "gpt-4.1",
      model_label: "Assigned studio model",
      generation_ready: true,
    });
    expect(mocks.models).toHaveBeenCalledExactlyOnceWith({ rpc });
  });

  it("keeps an existing assignment editable during a registry outage and marks generation unavailable", async () => {
    const actual = await vi.importActual<
      typeof import("../lib/model-registry")
    >("../lib/model-registry");
    mocks.models.mockImplementation(actual.getRegistryModelsForEditing);
    const rpc = vi.fn(async (name: string) =>
      name === "chainlab_list_models"
        ? { data: null, error: { code: "PGRST202" } }
        : { data: { step, settings }, error: null },
    );
    mocks.auth.mockResolvedValue({ db: { rpc }, user: { id: "admin" } });
    const response = await EDIT_STEP(
      request("PATCH", {
        ...canonicalStep,
        model_id: modelId,
        model: "",
        role: "system",
      }),
      context(),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).step).toMatchObject({
      model_id: modelId,
      role: "system",
      model: "",
      generation_ready: false,
    });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "chainlab_list_models",
      "chainlab_update_step",
    ]);
  });

  it("propagates registry permission denials before writing a step", async () => {
    mocks.models.mockRejectedValue(new ApiError(403, "Registry access denied"));
    const rpc = vi.fn();
    mocks.auth.mockResolvedValue({ db: { rpc }, user: { id: "admin" } });
    const response = await EDIT_STEP(
      request("PATCH", canonicalStep),
      context(),
    );
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns created and reordered steps using the established API shapes", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: { step: { ...step, role: "user", model_id: null }, settings },
        error: null,
      })
      .mockResolvedValueOnce({ data: snapshot, error: null });
    mocks.auth.mockResolvedValue({ db: { rpc }, user: { id: "admin" } });
    const appended = await APPEND(request("POST", canonicalStep), context());
    const ordered = await ORDER(
      request("PUT", { stepIds: [stepId] }),
      context(),
    );
    expect(appended.status).toBe(201);
    expect((await appended.json()).step.model_id).toBeNull();
    expect(ordered.status).toBe(200);
    expect((await ordered.json()).steps[0]).toMatchObject({
      id: stepId,
      role: "system",
    });
  });

  it.each(["23001", "23503"])(
    "offers deactivation when existing media prevent chain deletion (%s)",
    async (code) => {
      const rpc = vi.fn().mockResolvedValue({
        data: null,
        error: { code, message: "private references" },
      });
      mocks.auth.mockResolvedValue({ db: { rpc }, user: { id: "admin" } });
      const response = await DELETE(request("DELETE"), context());
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain("Draft to deactivate");
    },
  );

  it("denies unauthorized users and invalid origins before issuing mutation RPCs", async () => {
    const rpc = vi.fn();
    mocks.auth.mockRejectedValue(new ApiError(403, "Superadmins only"));
    expect(
      (await PATCH(request("PATCH", { name: "Changed" }), context())).status,
    ).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValue({ db: { rpc }, user: { id: "admin" } });
    expect(
      (
        await PATCH(
          request("PATCH", { name: "Changed" }, "https://other.example"),
          context(),
        )
      ).status,
    ).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});
