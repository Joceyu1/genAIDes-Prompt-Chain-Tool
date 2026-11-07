import type { ChainStep } from "./types";
export class GenerationError extends Error {}

const MAX_PROVIDER_ERROR_BYTES = 16 * 1024;
const UNKNOWN_PROVIDER_LIMIT_MESSAGE =
  "The AI provider is busy or its usage limit was reached. Try again later.";
const BILLING_PROVIDER_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "billing_hard_limit_reached",
  "billing_not_active",
]);

async function providerLimitMessage(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (!response.body) return UNKNOWN_PROVIDER_LIMIT_MESSAGE;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelOnAbort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    // Bound bytes actually read: Content-Length can be absent or inaccurate.
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROVIDER_ERROR_BYTES) {
        // Cleanup must not let a stalled upstream cancellation delay our limit.
        void reader.cancel().catch(() => {});
        signal.throwIfAborted();
        return UNKNOWN_PROVIDER_LIMIT_MESSAGE;
      }
      chunks.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || !("error" in data))
      return UNKNOWN_PROVIDER_LIMIT_MESSAGE;
    const error = data.error;
    if (!error || typeof error !== "object")
      return UNKNOWN_PROVIDER_LIMIT_MESSAGE;
    // Only exact provider codes/types can select our own static messages.
    // Never use the provider's message: it can echo keys, prompts or user data.
    const codes = [
      "code" in error ? error.code : undefined,
      "type" in error ? error.type : undefined,
    ].filter((value): value is string => typeof value === "string");
    if (codes.some((code) => BILLING_PROVIDER_CODES.has(code)))
      return "The AI provider reported a billing or credit problem. Ask your administrator to check API billing, available credits, and spending limits before retrying.";
    if (codes.includes("rate_limit_exceeded"))
      return "The AI provider is temporarily rate limited. Wait a moment and try again.";
    return UNKNOWN_PROVIDER_LIMIT_MESSAGE;
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    )
      throw error;
    return UNKNOWN_PROVIDER_LIMIT_MESSAGE;
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
}

export function renderPrompt(
  template: string,
  input: string,
  previous: string,
  outputs: string[],
): string {
  return template.replace(
    /\{\{\s*(input|previous|step\.(\d+))\s*\}\}/g,
    (_match, name: string, number: string) => {
      if (name === "input") return input;
      if (name === "previous") return previous;
      const index = Number(number) - 1;
      if (index < 0 || index >= outputs.length)
        throw new GenerationError(
          `Step ${number} is not available yet. Reference an earlier step.`,
        );
      return outputs[index];
    },
  );
}
export type GeneratedOutput =
  | { kind: "text"; text: string }
  | { kind: "image"; bytes: Buffer; mime: string };
export type GenerateOptions = {
  apiKey: string;
  step: ChainStep;
  prompt: string;
  previous: string;
  image?: string;
  signal: AbortSignal;
};
export async function generateStep({
  apiKey,
  step,
  prompt,
  previous,
  image,
  signal,
}: GenerateOptions): Promise<GeneratedOutput> {
  let endpoint: string;
  let body: BodyInit;
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (step.kind === "text") {
    endpoint = "https://api.openai.com/v1/chat/completions";
    headers["Content-Type"] = "application/json";
    const role = step.role ?? "user";
    if (!["system", "user", "assistant"].includes(role))
      throw new GenerationError("Choose a valid prompt role for this step.");
    const previousContext = `Input from the previous step:\n${previous || "(No text input)"}`;
    const content: unknown[] = [
      {
        type: "text",
        text:
          role === "user" ? `${prompt}\n\n${previousContext}` : previousContext,
      },
    ];
    if (image)
      content.push({
        type: "image_url",
        image_url: { url: image, detail: "auto" },
      });
    body = JSON.stringify({
      model: step.model,
      max_completion_tokens: 1200,
      // Vision content belongs to a user message. Keep an assigned system or
      // assistant prompt in its own role while passing the same prior context.
      messages:
        role === "user"
          ? [{ role, content }]
          : [
              { role, content: prompt },
              { role: "user", content },
            ],
    });
  } else if (image) {
    endpoint = "https://api.openai.com/v1/images/edits";
    const [metadata, encoded] = image.split(",");
    const mime = metadata.match(/data:(.*?);/)?.[1] || "image/png";
    const form = new FormData();
    form.set("model", step.model);
    form.set(
      "prompt",
      `${prompt}\n\nPrevious step: ${previous}`.slice(0, 32000),
    );
    form.set(
      "image",
      new Blob([new Uint8Array(Buffer.from(encoded, "base64"))], {
        type: mime,
      }),
      `input.${mime.split("/")[1]}`,
    );
    form.set("size", "1024x1024");
    form.set("quality", "low");
    form.set("n", "1");
    body = form;
  } else {
    endpoint = "https://api.openai.com/v1/images/generations";
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      model: step.model,
      prompt: `${prompt}\n\nPrevious step: ${previous}`.slice(0, 32000),
      size: "1024x1024",
      quality: "low",
      n: 1,
    });
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body,
    signal,
  });
  if (!response.ok) {
    // Only 429 responses are inspected, using bounded parsing and exact codes.
    const message =
      response.status === 401
        ? "The AI provider key was rejected. Contact your administrator."
        : response.status === 429
          ? await providerLimitMessage(response, signal)
          : response.status === 400
            ? "The AI provider could not process this prompt or image. Check this step and try again."
            : "The AI provider could not complete this step. Try again later.";
    throw new GenerationError(message);
  }
  if (Number(response.headers.get("content-length") || 0) > 30_000_000)
    throw new GenerationError("The AI output exceeded the size limit.");
  const data = await response.json();
  if (step.kind === "text") {
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim())
      throw new GenerationError(
        "The AI provider returned no text for this step.",
      );
    return { kind: "text", text };
  }
  const b64 = data.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64)
    throw new GenerationError(
      "The AI provider returned no image for this step.",
    );
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > 20 * 1024 * 1024)
    throw new GenerationError("The generated image exceeded the size limit.");
  return { kind: "image", bytes, mime: "image/png" };
}
