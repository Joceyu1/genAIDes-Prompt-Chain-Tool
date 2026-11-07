import type { StepKind } from "./types";

export type GenerationProvider = "gemini" | "openai";

export const DEFAULT_TEXT_MODEL = "gemini-flash-lite-latest";
export const GEMINI_TEXT_MODEL_PATTERN =
  "^gemini-([0-9]+([.][0-9]+)?-flash(-lite)?(-(001|latest|preview(-[0-9]{2}(-[0-9]{2,4})?)?))?|flash-lite-latest)$";
const geminiTextModel = new RegExp(GEMINI_TEXT_MODEL_PATTERN);
const isGeminiTextModel = (model: string) =>
  geminiTextModel.exec(model)?.[0] === model;

export const GEMINI_TEXT_MODELS = [
  DEFAULT_TEXT_MODEL,
  "gemini-3.8-flash",
] as const;
export const OPENAI_TEXT_MODELS = [
  "gpt-4.1-mini",
  "gpt-4.1",
  "gpt-4o-mini",
] as const;
export const TEXT_MODELS = [
  ...GEMINI_TEXT_MODELS,
  ...OPENAI_TEXT_MODELS,
] as const;
export const IMAGE_MODELS = ["gpt-image-1"] as const;

export const MODEL_CHOICES = {
  text: [
    { value: DEFAULT_TEXT_MODEL, label: "Gemini Flash Lite (latest)" },
    { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { value: "gpt-4.1-mini", label: "GPT-4.1 mini · OpenAI paid API" },
    { value: "gpt-4.1", label: "GPT-4.1 · OpenAI paid API" },
    { value: "gpt-4o-mini", label: "GPT-4o mini · OpenAI paid API" },
  ],
  image: [{ value: "gpt-image-1", label: "GPT Image 1 · OpenAI paid API" }],
} as const;

/** Google registry entries can include this documented model resource prefix. */
export function normalizeModelKey(model: string): string {
  if (model.startsWith("models/") && isGeminiTextModel(model.slice(7)))
    return model.slice(7);
  return model;
}

export function getModelProvider(
  model: string,
): GenerationProvider | undefined {
  const key = normalizeModelKey(model);
  if (isGeminiTextModel(key)) return "gemini";
  if (
    (OPENAI_TEXT_MODELS as readonly string[]).includes(key) ||
    (IMAGE_MODELS as readonly string[]).includes(key)
  )
    return "openai";
}

export function getSupportedModelKind(model: string): StepKind | undefined {
  const key = normalizeModelKey(model);
  if ((IMAGE_MODELS as readonly string[]).includes(key)) return "image";
  if (getModelProvider(key)) return "text";
}

/** Provider identity must come from the registry, never from a guessed UUID. */
export function normalizeRegistryProvider(
  provider: string,
): GenerationProvider | undefined {
  const name = provider.trim().toLowerCase().replace(/[ _]+/g, "-");
  if (name === "openai") return "openai";
  if (
    [
      "gemini",
      "google",
      "google-ai",
      "google-ai-studio",
      "google-gemini",
      "google-genai",
      "google-generative-ai",
      "google-generative-language",
    ].includes(name)
  )
    return "gemini";
}
