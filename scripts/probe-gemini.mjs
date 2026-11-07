import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROBE_MARKER = "[chainlab-gemini-probe]";
export const LATENCY_MARKER = "[chainlab-gemini-latency]";
export const shouldProbe = (message) =>
  typeof message === "string" && message.includes(PROBE_MARKER);
const MODEL = "gemini-flash-lite-latest";
const SAFE_STATUSES = new Set([
  "INVALID_ARGUMENT",
  "FAILED_PRECONDITION",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "NOT_FOUND",
  "RESOURCE_EXHAUSTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "UNIMPLEMENTED",
]);
const SAFE_REASONS = new Set([
  "API_KEY_INVALID",
  "API_KEY_SERVICE_BLOCKED",
  "API_KEY_IP_ADDRESS_BLOCKED",
  "API_KEY_HTTP_REFERRER_BLOCKED",
  "SERVICE_DISABLED",
  "BILLING_DISABLED",
  "CONSUMER_INVALID",
  "RATE_LIMIT_EXCEEDED",
]);

async function readJSON(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32768) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/** Explicit one-commit diagnostic; keys, provider messages and text stay private. */
export async function probeGemini({ key, fetchImpl = fetch }) {
  if (!key) return [{ outcome: "missing_key" }];
  const results = [];
  for (const version of ["v1", "v1beta"]) {
    try {
      const response = await fetchImpl(
        `https://generativelanguage.googleapis.com/${version}/models/${MODEL}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": key,
          },
          body: JSON.stringify({
            contents: [
              { role: "user", parts: [{ text: "Reply with only OK." }] },
            ],
            generationConfig: { maxOutputTokens: 1200 },
          }),
          signal: AbortSignal.timeout(15000),
        },
      );
      const data = await readJSON(response);
      const error = data?.error;
      const reasons = Array.isArray(error?.details)
        ? error.details
            .filter(
              (d) =>
                d?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" &&
                SAFE_REASONS.has(d.reason),
            )
            .map((d) => d.reason)
        : [];
      const candidate = data?.candidates?.[0];
      const hasText =
        Array.isArray(candidate?.content?.parts) &&
        candidate.content.parts.some(
          (p) =>
            p?.thought !== true && typeof p?.text === "string" && p.text.trim(),
        );
      results.push({
        version,
        httpStatus: response.status,
        ...(SAFE_STATUSES.has(error?.status) ? { status: error.status } : {}),
        ...(reasons.length ? { reasons: [...new Set(reasons)] } : {}),
        ...(response.ok
          ? { completed: candidate?.finishReason === "STOP" && hasText }
          : {}),
      });
      if (
        response.ok ||
        reasons.includes("API_KEY_INVALID") ||
        [401, 403, 429].includes(response.status)
      )
        break;
    } catch (error) {
      results.push({
        version,
        outcome: ["AbortError", "TimeoutError"].includes(error?.name)
          ? "timeout"
          : "transport_error",
      });
    }
  }
  return results;
}

/** Fixed, nonpersonal caption sample: compare latency before changing settings. */
export async function probeGeminiLatency({
  key,
  fetchImpl = fetch,
  now = Date.now,
}) {
  if (!key) return [{ outcome: "missing_key" }];
  const results = [];
  for (const mode of ["default", "thinking_off"]) {
    const started = now();
    const signal = AbortSignal.timeout(25000);
    try {
      const response = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": key,
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: "Write five short, funny captions about A cat wearing sunglasses\n\nInput from the previous step:\nA cat wearing sunglasses",
                  },
                ],
              },
            ],
            generationConfig: {
              maxOutputTokens: 1200,
              ...(mode === "thinking_off"
                ? { thinkingConfig: { thinkingBudget: 0 } }
                : {}),
            },
          }),
          signal,
        },
      );
      const data = await readJSON(response);
      if (signal.aborted) {
        results.push({
          mode,
          outcome: "timeout",
          durationMs: Math.max(0, now() - started),
        });
        continue;
      }
      const candidate = data?.candidates?.[0];
      const completed =
        candidate?.finishReason === "STOP" &&
        Array.isArray(candidate?.content?.parts) &&
        candidate.content.parts.some(
          (p) =>
            p?.thought !== true && typeof p?.text === "string" && p.text.trim(),
        );
      const usage = data?.usageMetadata;
      const metric = (value) =>
        Number.isInteger(value) && value >= 0 && value <= 10000000;
      results.push({
        mode,
        httpStatus: response.status,
        durationMs: Math.max(0, now() - started),
        ...(SAFE_STATUSES.has(data?.error?.status)
          ? { status: data.error.status }
          : {}),
        ...(response.ok ? { completed } : {}),
        ...(metric(usage?.thoughtsTokenCount)
          ? { thoughtTokens: usage.thoughtsTokenCount }
          : {}),
        ...(metric(usage?.candidatesTokenCount)
          ? { outputTokens: usage.candidatesTokenCount }
          : {}),
      });
      if ([401, 403, 429].includes(response.status)) break;
    } catch (error) {
      results.push({
        mode,
        outcome: ["AbortError", "TimeoutError"].includes(error?.name)
          ? "timeout"
          : "transport_error",
        durationMs: Math.max(0, now() - started),
      });
    }
  }
  return results;
}

async function main() {
  if (process.env.VERCEL_GIT_COMMIT_MESSAGE?.includes(LATENCY_MARKER)) {
    const results = await probeGeminiLatency({
      key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    });
    for (const result of results)
      console.log(`CHAINLAB_GEMINI_LATENCY ${JSON.stringify(result)}`);
    return;
  }
  if (!shouldProbe(process.env.VERCEL_GIT_COMMIT_MESSAGE)) return;
  const results = await probeGemini({
    key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  });
  for (const result of results)
    console.log(`CHAINLAB_GEMINI_PROBE ${JSON.stringify(result)}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
