import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_MODEL,
  getModelProvider,
  getSupportedModelKind,
  normalizeModelKey,
  normalizeRegistryProvider,
} from "../lib/model-catalog";
import { generationStepSchema, stepSchema } from "../lib/validation";

const textStep = {
  name: "Captions",
  prompt: "Write five captions about {{input}}.",
  kind: "text" as const,
  model: DEFAULT_TEXT_MODEL,
  role: "user" as const,
  model_id: null,
};

describe("provider-aware model choices", () => {
  it.each([
    "gemini-flash-lite-latest",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-2.5-flash-preview-09-2025",
    "gemini-2.0-flash-001",
    "models/gemini-3.5-flash-lite",
  ])("supports text generation for the Flash model %s", (model) => {
    expect(getModelProvider(model)).toBe("gemini");
    expect(getSupportedModelKind(model)).toBe("text");
    expect(stepSchema.safeParse({ ...textStep, model }).success).toBe(true);
    expect(generationStepSchema.safeParse({ ...textStep, model }).success).toBe(
      true,
    );
    expect(
      generationStepSchema.safeParse({ ...textStep, model, kind: "image" })
        .success,
    ).toBe(false);
  });

  it.each([
    "gemini-3.5-flash-image",
    "gemini-3.5-flash-native-audio-preview",
    "gemini-3.5-flash-preview-tts",
    "gemini-3.5-flash-live",
    "gemini-embedding-001",
    "gemini-flash-latest",
    "https://example.com/gemini-3.8-flash",
    "models/models/gemini-3.8-flash",
    "models/gpt-4.1-mini",
    "gemini-3.8-flash/../../gpt-4.1-mini",
    "gemini-3.8-flash?key=private",
    " gemini-3.8-flash",
    "gemini-3.8-flash\n",
    "models/gemini-3.8-flash\r\n",
  ])("does not treat an unsupported key as runnable: %s", (model) => {
    expect(getModelProvider(model)).toBeUndefined();
    expect(getSupportedModelKind(model)).toBeUndefined();
    expect(generationStepSchema.safeParse({ ...textStep, model }).success).toBe(
      false,
    );
  });

  it("normalizes only a valid Google model resource prefix", () => {
    expect(normalizeModelKey("models/gemini-3.8-flash")).toBe(
      "gemini-3.8-flash",
    );
    expect(normalizeModelKey("models/gpt-4.1-mini")).toBe(
      "models/gpt-4.1-mini",
    );
  });

  it.each(["google", "gemini", "google-ai-studio", "Google_AI_Studio"])(
    "recognizes the Google provider alias %s",
    (provider) => expect(normalizeRegistryProvider(provider)).toBe("gemini"),
  );

  it("preserves explicit paid OpenAI support while rejecting unknown provider aliases", () => {
    expect(getModelProvider("gpt-4.1-mini")).toBe("openai");
    expect(getModelProvider("gpt-image-1")).toBe("openai");
    expect(getSupportedModelKind("gpt-image-1")).toBe("image");
    expect(normalizeRegistryProvider("OpenAI")).toBe("openai");
    expect(normalizeRegistryProvider("https://google.example")).toBeUndefined();
    expect(normalizeRegistryProvider("google-proxy")).toBeUndefined();
    expect(
      stepSchema.safeParse({ ...textStep, model: "gpt-4.1-mini" }).success,
    ).toBe(true);
  });
});
