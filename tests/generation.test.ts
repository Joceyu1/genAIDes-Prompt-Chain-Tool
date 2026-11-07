import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateStep, GenerationError } from "../lib/generation";
import type { ChainStep } from "../lib/types";

const fetchMock = vi.fn();
const image = "data:image/png;base64,cG5n";
const step: ChainStep = {
  id: "11111111-1111-4111-8111-111111111111",
  chain_id: "22222222-2222-4222-8222-222222222222",
  name: "Describe",
  prompt: "Describe the input",
  kind: "text",
  model: "gpt-4.1-mini",
  position: 1,
};

function generate(overrides: Partial<ChainStep> = {}, withImage = false) {
  return generateStep({
    apiKey: "test-key",
    step: { ...step, ...overrides },
    prompt: "Describe the input",
    previous: "A cat wearing a hat",
    ...(withImage ? { image } : {}),
    signal: new AbortController().signal,
  });
}

function sentBody() {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock
    .mockReset()
    .mockResolvedValue(
      Response.json({ choices: [{ message: { content: "A stylish cat" } }] }),
    );
});
afterEach(() => vi.unstubAllGlobals());

describe("provider generation requests", () => {
  it("defaults an unassigned role to user and passes prior output with the prompt", async () => {
    await expect(generate()).resolves.toEqual({
      kind: "text",
      text: "A stylish cat",
    });
    expect(sentBody()).toMatchObject({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Describe the input\n\nInput from the previous step:\nA cat wearing a hat",
            },
          ],
        },
      ],
    });
  });

  it.each(["system", "assistant"])(
    "honors a %s prompt while keeping previous output and image in user context",
    async (role) => {
      await generate({ role }, true);
      expect(sentBody().messages).toEqual([
        { role, content: "Describe the input" },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Input from the previous step:\nA cat wearing a hat",
            },
            { type: "image_url", image_url: { url: image, detail: "auto" } },
          ],
        },
      ]);
    },
  );

  it("keeps an explicit user prompt and image together", async () => {
    await generate({ role: "user" }, true);
    expect(sentBody().messages).toHaveLength(1);
    expect(sentBody().messages[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text" },
        { type: "image_url", image_url: { url: image } },
      ],
    });
  });

  it("rejects an invalid role before contacting the provider", async () => {
    await expect(generate({ role: "developer" })).rejects.toThrow(
      "Choose a valid prompt role for this step.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps provider errors free of the response body", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: { message: "private prompt echoed here" } },
        { status: 429 },
      ),
    );
    await expect(generate()).rejects.toThrow(
      new GenerationError(
        "The AI provider is busy or its usage limit was reached. Try again later.",
      ),
    );
  });

  it("preserves image generation without an input image", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: [{ b64_json: Buffer.from("png").toString("base64") }],
      }),
    );
    await expect(
      generate({ kind: "image", model: "gpt-image-1", role: "system" }),
    ).resolves.toEqual({
      kind: "image",
      bytes: Buffer.from("png"),
      mime: "image/png",
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.openai.com/v1/images/generations",
    );
    expect(sentBody()).toMatchObject({
      model: "gpt-image-1",
      prompt: "Describe the input\n\nPrevious step: A cat wearing a hat",
    });
  });

  it("preserves image editing with an input image", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: [{ b64_json: Buffer.from("png").toString("base64") }],
      }),
    );
    await generate({ kind: "image", model: "gpt-image-1" }, true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.openai.com/v1/images/edits",
    );
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("model")).toBe("gpt-image-1");
    expect(form.get("prompt")).toBe(
      "Describe the input\n\nPrevious step: A cat wearing a hat",
    );
    expect(form.get("image")).toBeInstanceOf(Blob);
  });
});

const unknownLimitMessage =
  "The AI provider is busy or its usage limit was reached. Try again later.";
const billingMessage =
  "The AI provider reported a billing or credit problem. Ask your administrator to check API billing, available credits, and spending limits before retrying.";
const rateLimitMessage =
  "The AI provider is temporarily rate limited. Wait a moment and try again.";

describe("safe provider 429 classification", () => {
  const sensitive =
    "sk-private-provider-key: private user prompt and image description";
  it.each([
    "insufficient_quota",
    "credit_balance_exhausted",
    "billing_hard_limit_reached",
    "billing_not_active",
  ])(
    "classifies the exact %s billing code without exposing provider text",
    async (code) => {
      fetchMock.mockResolvedValue(
        Response.json(
          { error: { message: sensitive, type: "requests", code } },
          { status: 429 },
        ),
      );
      const error = await generate().catch((error) => error);
      expect(error).toBeInstanceOf(GenerationError);
      expect(error.message).toBe(billingMessage);
      expect(String(error)).not.toContain(sensitive);
      expect(String(error)).not.toContain("sk-private-provider-key");
    },
  );

  it.each([
    "insufficient_quota",
    "credit_balance_exhausted",
    "billing_hard_limit_reached",
    "billing_not_active",
  ])(
    "recognizes %s in error.type without relying on a message",
    async (type) => {
      fetchMock.mockResolvedValue(
        Response.json(
          { error: { message: sensitive, type, code: null } },
          { status: 429 },
        ),
      );
      await expect(generate()).rejects.toThrow(
        new GenerationError(billingMessage),
      );
    },
  );

  it.each(["code", "type"])(
    "recognizes a temporary rate limit in error.%s",
    async (field) => {
      fetchMock.mockResolvedValue(
        Response.json(
          { error: { message: sensitive, [field]: "rate_limit_exceeded" } },
          { status: 429 },
        ),
      );
      await expect(generate()).rejects.toThrow(
        new GenerationError(rateLimitMessage),
      );
    },
  );

  it.each([
    {
      message: "insufficient_quota " + sensitive,
      code: "unknown_limit",
      type: "requests",
    },
    { message: sensitive, code: "INSUFFICIENT_QUOTA" },
    { message: sensitive, code: "insufficient_quota_extra" },
    { message: sensitive, code: { code: "insufficient_quota" } },
  ])(
    "keeps an unrecognized error neutral and ignores its message (%j)",
    async (error) => {
      fetchMock.mockResolvedValue(Response.json({ error }, { status: 429 }));
      await expect(generate()).rejects.toThrow(
        new GenerationError(unknownLimitMessage),
      );
    },
  );

  it.each([
    null,
    { error: null },
    { error: sensitive },
    { code: "insufficient_quota" },
  ])("keeps unexpected JSON shapes neutral (%j)", async (payload) => {
    fetchMock.mockResolvedValue(Response.json(payload, { status: 429 }));
    await expect(generate()).rejects.toThrow(
      new GenerationError(unknownLimitMessage),
    );
  });

  it("keeps malformed JSON neutral without exposing raw content", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        `{"error":{"code":"insufficient_quota","message":"${sensitive}`,
        { status: 429 },
      ),
    );
    await expect(generate()).rejects.toThrow(
      new GenerationError(unknownLimitMessage),
    );
  });

  it("does not classify oversized JSON even when Content-Length understates its size", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "insufficient_quota", message: sensitive.repeat(400) },
        }),
        { status: 429, headers: { "content-length": "1" } },
      ),
    );
    await expect(generate()).rejects.toThrow(
      new GenerationError(unknownLimitMessage),
    );
  });

  it("stops reading at 16 KiB and does not wait for stalled cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const pull = vi.fn(
      (controller: ReadableStreamDefaultController<Uint8Array>) =>
        controller.enqueue(new Uint8Array(9000)),
    );
    const body = new ReadableStream<Uint8Array>(
      { pull, cancel },
      { highWaterMark: 0 },
    );
    fetchMock.mockResolvedValue(new Response(body, { status: 429 }));
    await expect(generate()).rejects.toThrow(
      new GenerationError(unknownLimitMessage),
    );
    expect(pull).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps absent bodies neutral", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 429 }));
    await expect(generate()).rejects.toThrow(
      new GenerationError(unknownLimitMessage),
    );
  });

  it.each(["AbortError", "TimeoutError"])(
    "preserves a response stream %s instead of replacing it with quota guidance",
    async (name) => {
      const failure = new DOMException(
        "The response body was interrupted",
        name,
      );
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.error(failure);
          },
        },
        { highWaterMark: 0 },
      );
      fetchMock.mockResolvedValue(new Response(body, { status: 429 }));
      await expect(generate()).rejects.toBe(failure);
    },
  );

  it("preserves timeout cancellation while reading a response body", async () => {
    const abort = new AbortController();
    const failure = new DOMException("Generation timed out", "TimeoutError");
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          abort.abort(failure);
        },
      },
      { highWaterMark: 0 },
    );
    fetchMock.mockResolvedValue(new Response(body, { status: 429 }));
    await expect(
      generateStep({
        apiKey: "test-key",
        step,
        prompt: "Private prompt",
        previous: "",
        signal: abort.signal,
      }),
    ).rejects.toBe(failure);
  });

  it("never reads provider error bodies for other status codes", async () => {
    const response = Response.json(
      { error: { code: "insufficient_quota", message: sensitive } },
      { status: 401 },
    );
    const getReader = vi.spyOn(response.body!, "getReader");
    fetchMock.mockResolvedValue(response);
    await expect(generate()).rejects.toThrow(
      "The AI provider key was rejected. Contact your administrator.",
    );
    expect(getReader).not.toHaveBeenCalled();
  });
});
