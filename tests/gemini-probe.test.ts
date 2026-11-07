import { describe, expect, it, vi } from "vitest";
import { probeGemini, shouldProbe } from "../scripts/probe-gemini.mjs";

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
