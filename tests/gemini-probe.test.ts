import { describe, expect, it, vi } from "vitest";
import {
  probeGemini,
  probeGeminiLatency,
  shouldProbe,
} from "../scripts/probe-gemini.mjs";

const key = "fixture-private-google-key";
const success = () =>
  Response.json({
    candidates: [
      { finishReason: "STOP", content: { parts: [{ text: "OK" }] } },
    ],
  });

describe("opt-in deployment Gemini check", () => {
  it("runs only for an explicitly marked commit", () => {
    expect(shouldProbe(undefined)).toBe(false);
    expect(shouldProbe("Normal application change")).toBe(false);
    expect(shouldProbe("Diagnose Gemini [chainlab-gemini-probe]")).toBe(true);
  });
  it("does not reuse an OpenAI key when Gemini is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await probeGemini({ key: undefined, fetchImpl })).toEqual([
      { outcome: "missing_key" },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("reports successful completion without returning text or the key", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(success());
    const result = await probeGemini({ key, fetchImpl });
    expect(result).toEqual([
      { version: "v1", httpStatus: 200, completed: true },
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1/models/gemini-flash-lite-latest:generateContent",
    );
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain("OK");
  });
  it("compares API versions after an upstream failure using the same Google provider", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: { status: "UNAVAILABLE", message: `${key} private prompt` },
          },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(success());
    const result = await probeGemini({ key, fetchImpl });
    expect(result).toEqual([
      { version: "v1", httpStatus: 503, status: "UNAVAILABLE" },
      { version: "v1beta", httpStatus: 200, completed: true },
    ]);
    expect(fetchImpl.mock.calls[1][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
    );
    expect(JSON.stringify(result)).not.toMatch(
      /fixture-private|private prompt/,
    );
  });
  it("stops after a recognized key rejection and excludes error messages and metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            status: "INVALID_ARGUMENT",
            message: key,
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "API_KEY_INVALID",
                metadata: { private: key },
              },
            ],
          },
        },
        { status: 400 },
      ),
    );
    const result = await probeGemini({ key, fetchImpl });
    expect(result).toEqual([
      {
        version: "v1",
        httpStatus: 400,
        status: "INVALID_ARGUMENT",
        reasons: ["API_KEY_INVALID"],
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it("never returns transport error messages", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(key));
    const result = await probeGemini({ key, fetchImpl });
    expect(result).toEqual([
      { version: "v1", outcome: "transport_error" },
      { version: "v1beta", outcome: "transport_error" },
    ]);
    expect(JSON.stringify(result)).not.toContain(key);
  });
});

describe("fixed-caption latency diagnostic", () => {
  it("compares the same caption with and without thinking, exposing numeric metrics only", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: key }] } },
          ],
          usageMetadata: { thoughtsTokenCount: 12, candidatesTokenCount: 45 },
        }),
      );
    let tick = 0;
    const result = await probeGeminiLatency({
      key,
      fetchImpl,
      now: () => (tick += 100),
    });
    expect(result).toEqual([
      {
        mode: "default",
        httpStatus: 200,
        durationMs: 100,
        completed: true,
        thoughtTokens: 12,
        outputTokens: 45,
      },
      {
        mode: "thinking_off",
        httpStatus: 200,
        durationMs: 100,
        completed: true,
        thoughtTokens: 12,
        outputTokens: 45,
      },
    ]);
    const bodies = fetchImpl.mock.calls.map(([, init]) =>
      JSON.parse(init!.body as string),
    );
    expect(bodies[0].generationConfig).toEqual({ maxOutputTokens: 1200 });
    expect(bodies[1].generationConfig).toEqual({
      maxOutputTokens: 1200,
      thinkingConfig: { thinkingBudget: 0 },
    });
    expect(bodies[0].contents).toEqual(bodies[1].contents);
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it("never turns a rejected thinking option into successful completion or exposes provider text", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(
        Response.json(
          { error: { status: "INVALID_ARGUMENT", message: key } },
          { status: 400 },
        ),
      );
    const result = await probeGeminiLatency({ key, fetchImpl });
    expect(result[0]).toMatchObject({ mode: "default", completed: true });
    expect(result[1]).toMatchObject({
      mode: "thinking_off",
      httpStatus: 400,
      status: "INVALID_ARGUMENT",
    });
    expect(result[1]).not.toHaveProperty("completed");
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it("stops when Google reports an exhausted request quota", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { status: "RESOURCE_EXHAUSTED", message: key } },
          { status: 429 },
        ),
      );
    const result = await probeGeminiLatency({ key, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result[0]).toMatchObject({
      httpStatus: 429,
      status: "RESOURCE_EXHAUSTED",
    });
    expect(JSON.stringify(result)).not.toContain(key);
  });
});
