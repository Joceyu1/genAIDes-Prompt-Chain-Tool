import type { ChainStep } from "./types";
import {
  getModelProvider,
  getSupportedModelKind,
  normalizeModelKey,
  type GenerationProvider,
} from "./model-catalog";
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

async function readBoundedProviderError(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  signal.throwIfAborted();
  if (!response.body) return null;
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
        return null;
      }
      chunks.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || !("error" in data)) return null;
    const error = data.error;
    if (!error || typeof error !== "object") return null;
    return error as Record<string, unknown>;
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    )
      throw error;
    return null;
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
}

async function providerLimitMessage(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const error = await readBoundedProviderError(response, signal);
  const codes = [error?.code, error?.type].filter(
    (value): value is string => typeof value === "string",
  );
  // Only exact provider codes/types select our static messages. Never expose
  // provider messages, descriptions, metadata or other arbitrary response text.
  if (codes.some((code) => BILLING_PROVIDER_CODES.has(code)))
    return "The AI provider reported a billing or credit problem. Ask your administrator to check API billing, available credits, and spending limits before retrying.";
  if (codes.includes("rate_limit_exceeded"))
    return "The AI provider is temporarily rate limited. Wait a moment and try again.";
  return UNKNOWN_PROVIDER_LIMIT_MESSAGE;
}

async function geminiLimitMessage(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const error = await readBoundedProviderError(response, signal);
  if (error?.status === "RESOURCE_EXHAUSTED" || error?.code === 429)
    return "The Gemini API quota or rate limit was reached. Check this project's quota and free-tier availability in Google AI Studio, then retry when quota is available.";
  return "The Gemini API is busy or its quota was reached. Try again later.";
}

export function getGenerationProvider(step: ChainStep): GenerationProvider {
  const provider = getModelProvider(step.model);
  if (!provider)
    throw new GenerationError(
      "Choose a supported Gemini or OpenAI model for this step.",
    );
  if (step.model_provider !== undefined && step.model_provider !== provider)
    throw new GenerationError(
      "The step's provider does not match its selected model. Choose the model again before running.",
    );
  if (getSupportedModelKind(step.model) !== step.kind)
    throw new GenerationError(
      "Choose a model that supports this step's output type.",
    );
  return provider;
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
type GeminiPart =
  { text: string } | { inlineData: { mimeType: string; data: string } };
async function generateGemini({
  apiKey,
  step,
  prompt,
  previous,
  image,
  signal,
}: GenerateOptions): Promise<GeneratedOutput> {
  const role = step.role ?? "user";
  if (!["system", "user", "assistant"].includes(role))
    throw new GenerationError("Choose a valid prompt role for this step.");
  const previousContext = `Input from the previous step:\n${previous || "(No text input)"}`;
  const parts: GeminiPart[] = [
    {
      text:
        role === "user" ? `${prompt}\n\n${previousContext}` : previousContext,
    },
  ];
  if (image) {
    const match =
      /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        image,
      );
    if (!match)
      throw new GenerationError(
        "Upload a PNG, JPEG or WebP image to use Gemini image input.",
      );
    parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }
  // Gemini uses user/model conversation roles and a separate system instruction.
  // Assistant prompts become a prior model turn, with a valid user-first history.
  const contents =
    role === "assistant"
      ? [
          { role: "user", parts },
          { role: "model", parts: [{ text: prompt }] },
          {
            role: "user",
            parts: [
              {
                text: "Continue from the assistant response above and return the final result for this step.",
              },
            ],
          },
        ]
      : [{ role: "user", parts }];
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(normalizeModelKey(step.model))}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents,
        ...(role === "system"
          ? { systemInstruction: { parts: [{ text: prompt }] } }
          : {}),
        generationConfig: { maxOutputTokens: 1200 },
      }),
      signal,
    },
  );
  if (!response.ok) {
    const message =
      response.status === 401 || response.status === 403
        ? "The Gemini API key was rejected or lacks permission for this model. Ask your administrator to check the Gemini key and project access."
        : response.status === 429
          ? await geminiLimitMessage(response, signal)
          : response.status === 404
            ? "The selected Gemini model is unavailable. Choose another supported Gemini model or check this project's model access."
            : response.status === 400
              ? "Gemini could not process this prompt or image. Check the selected model, prompt, image, and Gemini API key."
              : "The Gemini API could not complete this step. Try again later.";
    throw new GenerationError(message);
  }
  if (Number(response.headers.get("content-length") || 0) > 30_000_000)
    throw new GenerationError("The Gemini output exceeded the size limit.");
  const data = await response.json();
  const blockReason = data?.promptFeedback?.blockReason;
  if (
    typeof blockReason === "string" &&
    blockReason &&
    blockReason !== "BLOCK_REASON_UNSPECIFIED"
  )
    throw new GenerationError(
      "Gemini blocked this prompt or image. Adjust the input and try again.",
    );
  const candidate = data?.candidates?.[0];
  if (
    [
      "SAFETY",
      "BLOCKLIST",
      "PROHIBITED_CONTENT",
      "SPII",
      "IMAGE_SAFETY",
      "RECITATION",
    ].includes(candidate?.finishReason)
  )
    throw new GenerationError(
      "Gemini blocked this output. Adjust the prompt or image and try again.",
    );
  if (candidate && candidate.finishReason !== "STOP")
    throw new GenerationError(
      "Gemini stopped before completing this step. Try a shorter prompt or another Gemini model.",
    );
  const text = Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts
        .filter(
          (part: { thought?: unknown; text?: unknown } | null) =>
            part && part.thought !== true && typeof part.text === "string",
        )
        .map((part: { text: string }) => part.text)
        .join("")
    : "";
  if (!text.trim())
    throw new GenerationError(
      "The Gemini API returned no final text for this step. Adjust the input or try another Gemini model.",
    );
  return { kind: "text", text };
}

export async function generateStep({
  apiKey,
  step,
  prompt,
  previous,
  image,
  signal,
}: GenerateOptions): Promise<GeneratedOutput> {
  const provider = getGenerationProvider(step);
  if (provider === "gemini")
    return generateGemini({ apiKey, step, prompt, previous, image, signal });
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
