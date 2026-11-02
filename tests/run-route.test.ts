import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainRun, ChainStep } from "../lib/types";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), generate: vi.fn() }));
vi.mock("@/lib/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/server")>()),
  requireAdmin: mocks.auth,
}));
vi.mock("@/lib/generation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/generation")>()),
  generateStep: mocks.generate,
}));
import { POST } from "../app/api/chains/[id]/runs/route";
import { ApiError } from "../lib/server";
import { GenerationError } from "../lib/generation";
const chainId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const makeStep = (index: number, prompt: string): ChainStep => ({
  id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
  chain_id: chainId,
  name: `Step ${index}`,
  kind: "text",
  model: "gpt-4.1-mini",
  prompt,
  position: index - 1,
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
  const storageFrom = vi.fn(() => ({ upload, createSignedUrl: signed }));
  const db = {
    from: vi.fn((table: string) => {
      if (table === "prompt_chains")
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: chainId }, error: null }),
            }),
          }),
        };
      if (table === "prompt_chain_steps")
        return {
          select: () => ({
            eq: () => ({ order: async () => ({ data: steps, error: null }) }),
          }),
        };
      return {
        insert: (value: Partial<ChainRun>) => {
          run = { ...run, ...value };
          return {
            select: () => ({
              single: async () => ({ data: run, error: null }),
            }),
          };
        },
        update: (value: Partial<ChainRun>) => {
          updates.push(structuredClone(value));
          run = { ...run, ...value };
          return {
            eq: () => ({
              error: null,
              select: () => ({
                single: async () => ({ data: run, error: null }),
              }),
            }),
          };
        },
      };
    }),
    storage: { from: storageFrom },
  };
  return { db, updates, upload, signed, storageFrom };
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
  mocks.auth.mockReset();
  mocks.generate.mockReset();
});
describe("persistent sequential run endpoint", () => {
  it("passes each output into the next step and persists a completed history entry", async () => {
    const { db, updates } = database([
      makeStep(1, "Describe {{input}}"),
      makeStep(2, "Make {{previous}} funny"),
    ]);
    mocks.auth.mockResolvedValue({ db, user: { id: "admin" } });
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
    });
    expect(updates.at(-1)).toMatchObject({
      status: "completed",
      outputs: [
        { content: "A cat wearing a tall hat" },
        { content: "The cat is the new head of fashion." },
      ],
    });
  });
  it("preserves earlier outputs and records failure when a later provider step fails", async () => {
    const { db, updates } = database([
      makeStep(1, "Describe"),
      makeStep(2, "Captions"),
    ]);
    mocks.auth.mockResolvedValue({ db, user: { id: "admin" } });
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
  it("stores image bytes privately and returns a signed URL rather than inline persisted media", async () => {
    const step = {
      ...makeStep(1, "Draw a cat"),
      kind: "image" as const,
      model: "gpt-image-1",
    };
    const { db, updates, upload, signed, storageFrom } = database([step]);
    mocks.auth.mockResolvedValue({ db, user: { id: "admin" } });
    mocks.generate.mockResolvedValue({
      kind: "image",
      bytes: Buffer.from("png"),
      mime: "image/png",
    });
    const response = await POST(request(), context());
    const data = await response.json();
    expect(response.status).toBe(201);
    expect(storageFrom).toHaveBeenCalledWith("prompt-chain-media");
    expect(upload).toHaveBeenCalledWith(
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
  it("denies an unauthorized run before reading the chain or calling the provider", async () => {
    mocks.auth.mockRejectedValue(new ApiError(403, "Superadmins only"));
    const response = await POST(request(), context());
    expect(response.status).toBe(403);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
