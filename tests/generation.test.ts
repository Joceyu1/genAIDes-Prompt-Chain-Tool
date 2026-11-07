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

function geminiGenerate(
  overrides: Partial<ChainStep> = {},
  withImage = false,
  signal = new AbortController().signal,
) {
  return generateStep({
    apiKey: "gemini-test-key",
    step: {
      ...step,
      model: "gemini-flash-lite-latest",
      model_provider: "gemini",
      ...overrides,
    },
    prompt: "Describe the input",
    previous: "A cat wearing a hat",
    ...(withImage ? { image } : {}),
    signal,
  });
}
const geminiResult = (parts: unknown[] = [{ text: "A stylish cat" }]) => ({
  candidates: [{ finishReason: "STOP", content: { role: "model", parts } }],
});

describe("explicit Gemini text generation", () => {
  beforeEach(() => fetchMock.mockResolvedValue(Response.json(geminiResult())));
  it("uses the fixed Google endpoint and API-key header with no bearer or query-string credentials", async () => {
    await expect(
      geminiGenerate({ model: "models/gemini-flash-lite-latest" }),
    ).resolves.toEqual({ kind: "text", text: "A stylish cat" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1/models/gemini-flash-lite-latest:generateContent",
    );
    const options = fetchMock.mock.calls[0][1];
    expect(options.headers).toEqual({
      "Content-Type": "application/json",
      "x-goog-api-key": "gemini-test-key",
    });
    expect(sentBody()).toMatchObject({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "Describe the input\n\nInput from the previous step:\nA cat wearing a hat",
            },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 1200 },
    });
    expect(sentBody()).not.toHaveProperty("systemInstruction");
  });
  it("keeps system instructions separate and image inline data in user content", async () => {
    await geminiGenerate({ role: "system" }, true);
    expect(sentBody()).toEqual({
      systemInstruction: { parts: [{ text: "Describe the input" }] },
      contents: [
        {
          role: "user",
          parts: [
            { text: "Input from the previous step:\nA cat wearing a hat" },
            { inlineData: { mimeType: "image/png", data: "cG5n" } },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 1200 },
    });
  });
  it("maps assistant prompts to a prior model turn in a valid user-first conversation", async () => {
    await geminiGenerate({ role: "assistant" }, true);
    expect(sentBody().contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "Input from the previous step:\nA cat wearing a hat" },
          { inlineData: { mimeType: "image/png", data: "cG5n" } },
        ],
      },
      { role: "model", parts: [{ text: "Describe the input" }] },
      {
        role: "user",
        parts: [
          {
            text: "Continue from the assistant response above and return the final result for this step.",
          },
        ],
      },
    ]);
  });
  it("joins visible text parts from the first candidate while excluding thoughts and non-text parts", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        candidates: [
          ...geminiResult([
            { text: "private reasoning", thought: true },
            { text: "A stylish" },
            { inlineData: { mimeType: "image/png", data: "ignored" } },
            null,
            { text: " cat", thought: false },
          ]).candidates,
          { content: { parts: [{ text: "Not the selected candidate" }] } },
        ],
      }),
    );
    await expect(geminiGenerate()).resolves.toEqual({
      kind: "text",
      text: "A stylish cat",
    });
  });
  it.each([
    "SAFETY",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "IMAGE_SAFETY",
    "RECITATION",
  ])(
    "does not record a %s-blocked candidate as completed",
    async (finishReason) => {
      fetchMock.mockResolvedValue(
        Response.json({
          candidates: [
            {
              finishReason,
              content: {
                parts: [{ text: "This partial output must not be returned" }],
              },
            },
          ],
        }),
      );
      await expect(geminiGenerate()).rejects.toThrow(
        "Gemini blocked this output",
      );
    },
  );
  it("does not expose prompt-feedback block details", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...geminiResult(),
        promptFeedback: {
          blockReason: "SAFETY",
          blockReasonMessage: "private prompt and provider detail",
        },
      }),
    );
    await expect(geminiGenerate()).rejects.toThrow(
      new GenerationError(
        "Gemini blocked this prompt or image. Adjust the input and try again.",
      ),
    );
  });
  it.each([
    { parts: [] },
    { parts: [{ thought: true, text: "Private reasoning only" }] },
    { parts: [{ text: "  " }] },
  ])("rejects empty or thought-only final text (%j)", async ({ parts }) => {
    fetchMock.mockResolvedValue(Response.json(geminiResult(parts)));
    await expect(geminiGenerate()).rejects.toThrow("returned no final text");
  });
  it.each([undefined, ""])(
    "requires explicit completion metadata before recording output (%j)",
    async (finishReason) => {
      fetchMock.mockResolvedValue(
        Response.json({
          candidates: [
            {
              finishReason,
              content: { parts: [{ text: "Possibly incomplete output" }] },
            },
          ],
        }),
      );
      await expect(geminiGenerate()).rejects.toThrow(
        "stopped before completing",
      );
    },
  );
  it("does not claim a truncated candidate completed successfully", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        candidates: [
          {
            finishReason: "MAX_TOKENS",
            content: { parts: [{ text: "Partial caption" }] },
          },
        ],
      }),
    );
    await expect(geminiGenerate()).rejects.toThrow("stopped before completing");
  });
  it.each([
    { model: "https://untrusted.example/gemini-flash-lite-latest" },
    { model: "gpt-4.1-mini", model_provider: "gemini" as const },
    { model: "gemini-flash-lite-latest", model_provider: "openai" as const },
    { kind: "image" as const },
    { role: "developer" },
  ])(
    "rejects unsupported model, provider, output or role before any request (%j)",
    async (overrides) => {
      await expect(geminiGenerate(overrides)).rejects.toBeInstanceOf(
        GenerationError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("rejects URL image inputs instead of causing server-side image fetches", async () => {
    await expect(
      generateStep({
        apiKey: "gemini-test-key",
        step: { ...step, model: "gemini-flash-lite-latest" },
        prompt: "Describe",
        previous: "",
        image: "https://untrusted.example/image.png",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Upload a PNG, JPEG or WebP");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("private Gemini provider errors without paid fallback", () => {
  const secret = "private-prompt-and-key-never-exposed";
  it.each([401, 403])(
    "reports HTTP %s key/permission failures without exposing the response",
    async (status) => {
      fetchMock.mockResolvedValue(
        Response.json(
          {
            error: {
              code: status,
              status: "PERMISSION_DENIED",
              message: secret,
            },
          },
          { status },
        ),
      );
      await expect(geminiGenerate()).rejects.toThrow(
        new GenerationError(
          "The Gemini API key was rejected or lacks permission for this model. Ask your administrator to check the Gemini key and project access.",
        ),
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );
  it("makes an unavailable model actionable without exposing provider details", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: { message: secret } }, { status: 404 }),
    );
    await expect(geminiGenerate()).rejects.toThrow(
      new GenerationError(
        "The selected Gemini model is unavailable. Choose another supported Gemini model or check this project's model access.",
      ),
    );
  });
  it.each([{ status: "RESOURCE_EXHAUSTED" }, { code: 429 }])(
    "uses exact structured quota/rate codes without treating unavailable free quota as billing proof (%j)",
    async (error) => {
      fetchMock.mockResolvedValueOnce(
        Response.json(
          {
            error: {
              ...error,
              message: secret,
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                  violations: [
                    { quotaValue: "0", description: secret, quotaId: secret },
                  ],
                },
              ],
            },
          },
          { status: 429 },
        ),
      );
      const failure = await geminiGenerate().catch((error) => error);
      expect(failure.message).toBe(
        "The Gemini API quota or rate limit was reached. Check this project's quota and free-tier availability in Google AI Studio, then retry when quota is available.",
      );
      expect(failure.message).not.toMatch(/billing|payment|credit/);
      expect(failure.message).not.toContain(secret);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toContain(
        "generativelanguage.googleapis.com",
      );
    },
  );
  it("keeps unknown or message-only codes neutral", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          error: {
            status: "resource_exhausted",
            message: "RESOURCE_EXHAUSTED " + secret,
          },
        },
        { status: 429 },
      ),
    );
    await expect(geminiGenerate()).rejects.toThrow(
      new GenerationError(
        "The Gemini API is busy or its quota was reached. Try again later.",
      ),
    );
  });
  it("keeps malformed quota JSON neutral", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        `{"error":{"status":"RESOURCE_EXHAUSTED","message":"${secret}`,
        { status: 429 },
      ),
    );
    await expect(geminiGenerate()).rejects.toThrow(
      new GenerationError(
        "The Gemini API is busy or its quota was reached. Try again later.",
      ),
    );
  });
  it("bounds the actual quota response stream even when Content-Length is false", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: secret.repeat(1000),
          },
        }),
        { status: 429, headers: { "content-length": "1" } },
      ),
    );
    await expect(geminiGenerate()).rejects.toThrow(
      new GenerationError(
        "The Gemini API is busy or its quota was reached. Try again later.",
      ),
    );
  });
  it("preserves quota-body timeout cancellation instead of replacing it with quota guidance", async () => {
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
    await expect(geminiGenerate({}, false, abort.signal)).rejects.toBe(failure);
  });
});

const geminiInvalidRequestMessage =
  "Gemini could not process this prompt or image. Check the selected model, prompt, image, and Gemini API key.";
const geminiPermissionMessage =
  "The Gemini API key was rejected or lacks permission for this model. Ask your administrator to check the Gemini key and project access.";
const geminiInvalidKeyMessage =
  "Google rejected the Gemini API key as invalid, expired, or unavailable. Ask your administrator to check the configured Google AI Studio key.";
const geminiRestrictedKeyMessage =
  "The Gemini API key's application or API restrictions block this server request. Ask your administrator to check its restrictions and access to the Generative Language API.";
const geminiDisabledServiceMessage =
  "The Generative Language API is disabled for this Google project. Ask your administrator to enable it for the Gemini API key's project.";
const geminiPreconditionMessage =
  "A Gemini API prerequisite is not satisfied. Check the Google AI Studio project, supported region, and free-tier eligibility before retrying.";

describe("private Google configuration diagnostics", () => {
  const sensitive = "private-provider-key-user-prompt-and-image-details";
  const errorInfo = (reason: string) => ({
    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
    reason,
    domain: "googleapis.com",
    metadata: {
      service: "generativelanguage.googleapis.com",
      consumer: sensitive,
      apiKey: sensitive,
    },
  });
  function configurationResponse(
    status: number,
    error: Record<string, unknown>,
  ) {
    return Response.json(
      {
        error: {
          code: status,
          status: "INVALID_ARGUMENT",
          message: sensitive,
          ...error,
        },
      },
      { status },
    );
  }
  it.each([400, 401, 403])(
    "recognizes canonical API_KEY_INVALID on HTTP%s without exposing provider text",
    async (status) => {
      fetchMock.mockResolvedValue(
        configurationResponse(status, {
          details: [errorInfo("API_KEY_INVALID")],
        }),
      );
      const failure = await geminiGenerate().catch((error) => error);
      expect(failure).toBeInstanceOf(GenerationError);
      expect(failure.message).toBe(geminiInvalidKeyMessage);
      expect(String(failure)).not.toContain(sensitive);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );
  it.each([
    "API_KEY_SERVICE_BLOCKED",
    "API_KEY_HTTP_REFERRER_BLOCKED",
    "API_KEY_IP_ADDRESS_BLOCKED",
    "API_KEY_ANDROID_APP_BLOCKED",
    "API_KEY_IOS_APP_BLOCKED",
  ])(
    "distinguishes canonical %s restrictions from a bad prompt",
    async (reason) => {
      fetchMock.mockResolvedValue(
        configurationResponse(403, {
          status: "PERMISSION_DENIED",
          details: [errorInfo(reason)],
        }),
      );
      await expect(geminiGenerate()).rejects.toThrow(
        new GenerationError(geminiRestrictedKeyMessage),
      );
    },
  );
  it("distinguishes a disabled service using typed ErrorInfo", async () => {
    fetchMock.mockResolvedValue(
      configurationResponse(403, {
        status: "PERMISSION_DENIED",
        details: [errorInfo("SERVICE_DISABLED")],
      }),
    );
    await expect(geminiGenerate()).rejects.toThrow(
      new GenerationError(geminiDisabledServiceMessage),
    );
  });
  it("reports a project precondition without claiming payment is required", async () => {
    fetchMock.mockResolvedValue(
      configurationResponse(400, {
        status: "FAILED_PRECONDITION",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.PreconditionFailure",
            violations: [{ description: sensitive, subject: sensitive }],
          },
        ],
      }),
    );
    const failure = await geminiGenerate().catch((error) => error);
    expect(failure.message).toBe(geminiPreconditionMessage);
    expect(failure.message).not.toMatch(/billing|payment|credit/);
    expect(failure.message).not.toContain(sensitive);
  });
  it("keeps ordinary invalid request arguments generic without interpreting violation descriptions", async () => {
    fetchMock.mockResolvedValue(
      configurationResponse(400, {
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            fieldViolations: [
              {
                field: "contents",
                description: "API_KEY_INVALID " + sensitive,
              },
            ],
          },
        ],
      }),
    );
    await expect(geminiGenerate()).rejects.toThrow(
      new GenerationError(geminiInvalidRequestMessage),
    );
  });
  it.each([
    { reason: "API_KEY_INVALID" },
    {
      "@type": "type.googleapis.com/unrelated.ErrorInfo",
      reason: "API_KEY_INVALID",
    },
    { "@type": "google.rpc.ErrorInfo", reason: "API_KEY_INVALID" },
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "api_key_invalid",
    },
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "API_KEY_INVALID_EXTRA",
    },
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "API_KEY_EXPIRED",
    },
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "API_KEY_NOT_FOUND",
    },
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "HTTP_REFERRER_BLOCKED",
    },
  ])(
    "does not infer key failure from an untyped or unknown reason (%j)",
    async (detail) => {
      fetchMock.mockResolvedValue(
        configurationResponse(400, {
          details: [detail],
          message: "API_KEY_INVALID " + sensitive,
        }),
      );
      await expect(geminiGenerate()).rejects.toThrow(
        new GenerationError(geminiInvalidRequestMessage),
      );
    },
  );
  it.each([400, 401, 403])(
    "preserves HTTP%s fallback guidance for malformed error JSON",
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response(`{"error":{"details":[${sensitive}`, { status }),
      );
      await expect(geminiGenerate()).rejects.toThrow(
        new GenerationError(
          status === 400
            ? geminiInvalidRequestMessage
            : geminiPermissionMessage,
        ),
      );
    },
  );
  it("ignores oversized configuration JSON despite an understated Content-Length", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            status: "INVALID_ARGUMENT",
            details: [errorInfo("API_KEY_INVALID")],
            message: sensitive.repeat(500),
          },
        }),
        { status: 400, headers: { "content-length": "1" } },
      ),
    );
    await expect(geminiGenerate()).rejects.toThrow(
      new GenerationError(geminiInvalidRequestMessage),
    );
  });
  it("keeps configuration diagnostics bounded when upstream cancellation stalls", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const pull = vi.fn(
      (controller: ReadableStreamDefaultController<Uint8Array>) =>
        controller.enqueue(new Uint8Array(9000)),
    );
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
        { status: 403 },
      ),
    );
    await expect(geminiGenerate()).rejects.toThrow(
      new GenerationError(geminiPermissionMessage),
    );
    expect(pull).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("preserves cancellation while reading a configuration error", async () => {
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
    fetchMock.mockResolvedValue(new Response(body, { status: 400 }));
    await expect(geminiGenerate({}, false, abort.signal)).rejects.toBe(failure);
  });
});

describe("safe Gemini HTTP service diagnostics", () => {
  it.each([
    [
      500,
      "The Gemini API encountered a temporary server error (HTTP 500). Try again later.",
    ],
    [
      502,
      "The Gemini API is temporarily unavailable (HTTP 502). Try again later.",
    ],
    [
      503,
      "The Gemini API is temporarily unavailable (HTTP 503). Try again later.",
    ],
    [504, "The Gemini API timed out (HTTP 504). Try again later."],
    [
      402,
      "The Gemini API could not complete this step (HTTP 402). Try again later.",
    ],
    [
      422,
      "The Gemini API could not complete this step (HTTP 422). Try again later.",
    ],
  ] as const)(
    "reports HTTP%s without exposing provider text or automatically retrying",
    async (status, expected) => {
      const response = Response.json(
        {
          error: {
            code: status,
            message: "private-provider-key-and-user-prompt",
            details: [{ description: "private image details" }],
          },
        },
        { status },
      );
      const getReader = vi.spyOn(response.body!, "getReader");
      fetchMock.mockResolvedValue(response);
      const failure = await geminiGenerate().catch((error) => error);
      expect(failure).toBeInstanceOf(GenerationError);
      expect(failure.message).toBe(expected);
      expect(failure.message).not.toContain("private");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toContain(
        "generativelanguage.googleapis.com",
      );
      expect(getReader).not.toHaveBeenCalled();
    },
  );
});
