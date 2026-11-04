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
