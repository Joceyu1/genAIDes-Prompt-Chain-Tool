import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainRun, ChainStep } from "../lib/types";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  generate: vi.fn(),
  models: vi.fn(),
}));
vi.mock("@/lib/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/server")>()),
  requireAdmin: mocks.auth,
}));
vi.mock("@/lib/generation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/generation")>()),
  generateStep: mocks.generate,
}));
vi.mock("@/lib/model-registry", () => ({ getRegistryModels: mocks.models }));
import { GET, POST } from "../app/api/chains/[id]/runs/route";
import { ApiError } from "../lib/server";
import { GenerationError } from "../lib/generation";
const chainId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const adminId = "44444444-4444-4444-8444-444444444444";
const makeStep = (index: number, prompt: string): ChainStep => ({
  id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
  chain_id: chainId,
  name: `Step ${index}`,
  kind: "text",
  model: "gpt-4.1-mini",
  prompt,
  position: index,
  role: "user",
  model_id: null,
});
function database(steps: ChainStep[]) {
  let run: ChainRun = {
    id: runId,
    chain_id: chainId,
    status: "running",
    input: "",
    outputs: [],
    error: null,
    created_at: "2026-11-02T00:00:00Z",
  };
  const updates: Partial<ChainRun>[] = [];
  const upload = vi.fn().mockResolvedValue({ error: null });
  const signed = vi.fn().mockResolvedValue({
    data: { signedUrl: "https://storage.example/private-signed-image" },
    error: null,
  });
  const remove = vi.fn().mockImplementation(async (paths: string[]) => ({
    data: paths.map((name) => ({ name })),
    error: null,
  }));
  const storageFrom = vi.fn(() => ({
    upload,
    createSignedUrl: signed,
    remove,
  }));
  const db = {
    rpc: vi.fn(async (name: string, args?: Record<string, unknown>) => {
      if (name === "chainlab_get_chain")
        return {
          data: {
            chain: {
              id: chainId,
              name: "Existing chain",
              description: "",
              source: "source_snapshot",
              is_active: true,
              created_at: "2026-11-02",
              updated_at: "2026-11-02",
            },
            steps: steps.map((step) => ({
              id: step.id,
              chain_id: step.chain_id,
              position: step.position,
              role: step.role,
              template: step.prompt,
              model_id: step.model_id,
              created_at: "2026-11-02",
              updated_at: "2026-11-02",
            })),
            settings: steps.map((step) => ({
              step_id: step.id,
              name: step.name,
              kind: step.kind,
              fallback_model: step.model,
            })),
          },
          error: null,
        };
      if (name === "chainlab_create_run") {
        run = { ...run, input: args?.p_input as string };
        return { data: run, error: null };
      }
      if (name === "chainlab_list_legacy_history")
        return { data: [], error: null };
      if (name === "chainlab_list_runs") return { data: [run], error: null };
      if (name === "chainlab_update_run") {
        const value = {
          status: args?.p_status,
          outputs: args?.p_outputs,
          error: args?.p_error,
        } as Partial<ChainRun>;
        updates.push(structuredClone(value));
        run = { ...run, ...value };
        return { data: [run], error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    }),
    storage: { from: storageFrom },
  };
  return { db, updates, upload, signed, remove, storageFrom };
}
const request = () =>
  new Request(`https://app.example/api/chains/${chainId}/runs`, {
    method: "POST",
    headers: {
      origin: "https://app.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ input: "A cat in a hat" }),
  });
const context = () => ({ params: Promise.resolve({ id: chainId }) });
beforeEach(() => {
  vi.stubEnv("AI_API_KEY", "test-provider-key");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GOOGLE_API_KEY", "");
  mocks.auth.mockReset();
  mocks.generate.mockReset();
  mocks.models.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());
describe("persistent sequential run endpoint", () => {
  it("uses existing-schema RPCs, passes each output into the next step, and saves completion", async () => {
    const { db, updates, upload } = database([
      makeStep(1, "Describe {{input}}"),
      makeStep(2, "Make {{previous}} funny"),
    ]);
    mocks.auth.mockResolvedValue({ db, user: { id: adminId } });
    mocks.generate
      .mockResolvedValueOnce({ kind: "text", text: "A cat wearing a tall hat" })
      .mockResolvedValueOnce({
        kind: "text",
        text: "The cat is the new head of fashion.",
      });
    const response = await POST(request(), context());
    const data = await response.json();
    expect(response.status).toBe(201);
    expect(data.run.status).toBe("completed");
    expect(data.run.outputs).toHaveLength(2);
    expect(mocks.generate.mock.calls[1][0]).toMatchObject({
      previous: "A cat wearing a tall hat",
      prompt: "Make A cat wearing a tall hat funny",
      step: { role: "user", position: 2 },
    });
    expect(updates.at(-1)).toMatchObject({
      status: "completed",
      outputs: [
        { content: "A cat wearing a tall hat" },
        { content: "The cat is the new head of fashion." },
      ],
    });
    expect(upload).not.toHaveBeenCalled();
    expect(db.rpc).toHaveBeenCalledWith("chainlab_create_run", {
      p_chain_id: chainId,
      p_input: "A cat in a hat",
    });
  });
  it("preserves earlier outputs and records failure when a later provider step fails", async () => {
    const { db, updates } = database([
      makeStep(1, "Describe"),
      makeStep(2, "Captions"),
    ]);
    mocks.auth.mockResolvedValue({ db, user: { id: adminId } });
    mocks.generate
      .mockResolvedValueOnce({ kind: "text", text: "A cat" })
      .mockRejectedValueOnce(new GenerationError("The AI provider is busy."));
    const response = await POST(request(), context());
    const data = await response.json();
    expect(response.status).toBe(502);
    expect(data.run.status).toBe("failed");
    expect(data.run.outputs).toHaveLength(1);
    expect(updates.at(-1)).toMatchObject({
      status: "failed",
      error: "The AI provider is busy.",
      outputs: [{ content: "A cat" }],
    });
  });
  it("probes private storage before generation, removes the probe, and persists paths only", async () => {
    const step = {
      ...makeStep(1, "Draw a cat"),
      kind: "image" as const,
      model: "gpt-image-1",
    };
    const { db, updates, upload, signed, remove, storageFrom } = database([
      step,
    ]);
    mocks.auth.mockResolvedValue({ db, user: { id: adminId } });
    mocks.generate.mockImplementationOnce(async () => {
      expect(remove).toHaveBeenCalledOnce();
      expect(
        db.rpc.mock.calls.some(([name]) => name === "chainlab_create_run"),
      ).toBe(true);
      return { kind: "image", bytes: Buffer.from("png"), mime: "image/png" };
    });
    const response = await POST(request(), context());
    const data = await response.json();
    expect(response.status).toBe(201);
    expect(storageFrom).toHaveBeenCalledWith("chainlab-generated-media");
    expect(upload).toHaveBeenNthCalledWith(
      2,
      `${chainId}/${runId}/${step.id}.png`,
      Buffer.from("png"),
      { contentType: "image/png", upsert: false },
    );
    expect(signed).toHaveBeenCalledWith(
      `${chainId}/${runId}/${step.id}.png`,
      3600,
    );
    expect(data.run.outputs[0].content).toBe(
      "https://storage.example/private-signed-image",
    );
    expect(updates.at(-1)?.outputs?.[0]).toMatchObject({
      content: "",
      image_path: `${chainId}/${runId}/${step.id}.png`,
    });
  });
  it.each(["upload", "read", "delete"])(
    "fails before creating history or charging when storage %s is denied",
    async (phase) => {
      const { db, upload, signed, remove } = database([
        { ...makeStep(1, "Draw"), kind: "image", model: "gpt-image-1" },
      ]);
      if (phase === "upload")
        upload.mockResolvedValue({ error: { message: "RLS" } });
      if (phase === "read")
        signed.mockResolvedValue({ error: { message: "RLS" }, data: null });
      if (phase === "delete")
        remove.mockResolvedValue({ error: null, data: [] });
      mocks.auth.mockResolvedValue({ db, user: { id: adminId } });
      const response = await POST(request(), context());
      expect(response.status).toBe(503);
      expect(mocks.generate).not.toHaveBeenCalled();
      expect(
        db.rpc.mock.calls.some(([name]) => name === "chainlab_create_run"),
      ).toBe(false);
      if (phase !== "upload") expect(remove).toHaveBeenCalledOnce();
    },
  );
  it("refuses unresolved model UUIDs before recording history or calling the provider", async () => {
    const { db } = database([
      {
        ...makeStep(1, "Describe"),
        model_id: "55555555-5555-4555-8555-555555555555",
      },
    ]);
    mocks.auth.mockResolvedValue({ db, user: { id: adminId } });
    expect((await POST(request(), context())).status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(
      db.rpc.mock.calls.some(([name]) => name === "chainlab_create_run"),
    ).toBe(false);
  });
  it("refuses inactive registry models before recording history or calling the provider", async () => {
    const modelId = "55555555-5555-4555-8555-555555555555";
    const { db } = database([
      { ...makeStep(1, "Describe"), model_id: modelId },
    ]);
    mocks.models.mockResolvedValue([
      {
        id: modelId,
        model: "gpt-4.1-mini",
        provider: "openai",
        label: "Disabled model",
        active: false,
      },
    ]);
    mocks.auth.mockResolvedValue({ db, user: { id: adminId } });
    expect((await POST(request(), context())).status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("loads saved history through its authenticated RPC", async () => {
    const { db } = database([]);
    mocks.auth.mockResolvedValue({ db, user: { id: adminId } });
    const response = await GET(
      new Request(`https://app.example/api/chains/${chainId}/runs`),
      context(),
    );
    expect(response.status).toBe(200);
    expect(db.rpc).toHaveBeenCalledWith("chainlab_list_runs", {
      p_chain_id: chainId,
    });
  });
  it("denies an unauthorized run before reading the chain or calling the provider", async () => {
    mocks.auth.mockRejectedValue(new ApiError(403, "Superadmins only"));
    expect((await POST(request(), context())).status).toBe(403);
    expect(mocks.models).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});

describe("provider-specific credentials before any generation work", () => {
  const geminiStep = (index = 1): ChainStep => ({
    ...makeStep(index, "Describe {{previous}}"),
    model: "gemini-flash-lite-latest",
  });
  function expectNoRun(
    db: ReturnType<typeof database>["db"],
    storageFrom: ReturnType<typeof database>["storageFrom"],
  ) {
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(storageFrom).not.toHaveBeenCalled();
    expect(
      db.rpc.mock.calls.some(([name]) => name === "chainlab_create_run"),
    ).toBe(false);
  }
  it("does not reuse an OpenAI key for a Gemini step", async () => {
    const { db, storageFrom } = database([geminiStep()]);
    mocks.auth.mockResolvedValue({ db, user: { id: adminId } });
    const response = await POST(request(), context());
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("connect a Gemini API key");
    expectNoRun(db, storageFrom);
  });
  it("does not reuse a Gemini key for an OpenAI step", async () => {
    vi.stubEnv("AI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    const { db, storageFrom } = database([makeStep(1, "Describe")]);
    mocks.auth.mockResolvedValue({ db, user: { id: adminId } });
    const response = await POST(request(), context());
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain(
      "connect an OpenAI API key",
    );
    expectNoRun(db, storageFrom);
  });
  it("checks a later missing provider before probing image storage or charging an earlier step", async () => {
    const { db, storageFrom } = database([
      { ...makeStep(1, "Draw"), kind: "image", model: "gpt-image-1" },
      geminiStep(2),
    ]);
    mocks.auth.mockResolvedValue({ db, user: { id: adminId } });
    const response = await POST(request(), context());
    expect(response.status).toBe(503);
    expectNoRun(db, storageFrom);
  });
  it("uses each explicitly selected provider's own key for a mixed chain", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    const { db } = database([
      geminiStep(),
      makeStep(2, "Make {{previous}} funny"),
    ]);
    mocks.auth.mockResolvedValue({ db, user: { id: adminId } });
    mocks.generate
      .mockResolvedValueOnce({ kind: "text", text: "A cat" })
      .mockResolvedValueOnce({
        kind: "text",
        text: "A cat with a career in hats",
      });
    const response = await POST(request(), context());
    expect(response.status).toBe(201);
    expect(mocks.generate.mock.calls[0][0]).toMatchObject({
      apiKey: "test-gemini-key",
      step: { model: "gemini-flash-lite-latest" },
    });
    expect(mocks.generate.mock.calls[1][0]).toMatchObject({
      apiKey: "test-provider-key",
      step: { model: "gpt-4.1-mini" },
      previous: "A cat",
    });
  });
  it("accepts the Google-key alias for Gemini without requiring OpenAI credentials", async () => {
    vi.stubEnv("AI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "test-google-key");
    const { db } = database([geminiStep()]);
    mocks.auth.mockResolvedValue({ db, user: { id: adminId } });
    mocks.generate.mockResolvedValue({ kind: "text", text: "A cat" });
    expect((await POST(request(), context())).status).toBe(201);
    expect(mocks.generate.mock.calls[0][0].apiKey).toBe("test-google-key");
  });
  it("preserves the OpenAI-key alias for an explicitly selected OpenAI model", async () => {
    vi.stubEnv("AI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const { db } = database([makeStep(1, "Describe")]);
    mocks.auth.mockResolvedValue({ db, user: { id: adminId } });
    mocks.generate.mockResolvedValue({ kind: "text", text: "A cat" });
    expect((await POST(request(), context())).status).toBe(201);
    expect(mocks.generate.mock.calls[0][0].apiKey).toBe("test-openai-key");
  });
});
