import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chainSchema,
  chainPatchSchema,
  stepSchema,
  orderSchema,
  runSchema,
} from "../lib/validation";
import { generateStep, renderPrompt } from "../lib/generation";
import type { ChainStep } from "../lib/types";
const step: ChainStep = {
  id: "1",
  chain_id: "2",
  name: "Describe",
  prompt: "Describe",
  kind: "text",
  model: "gpt-4.1-mini",
  position: 0,
};
afterEach(() => vi.unstubAllGlobals());
describe("chain and step validation", () => {
  it("trims names and supplies safe chain defaults", () =>
    expect(chainSchema.parse({ name: "  Captions  " })).toEqual({
      name: "Captions",
      description: "",
      status: "draft",
    }));
  it("rejects empty updates and injected columns", () => {
    expect(chainPatchSchema.safeParse({}).success).toBe(false);
    expect(chainPatchSchema.parse({ name: "Renamed" })).toEqual({
      name: "Renamed",
    });
    expect(
      chainSchema.safeParse({ name: "X", created_by: "someone" }).success,
    ).toBe(false);
  });
  it("enforces model compatibility and required prompts", () => {
    expect(
      stepSchema.safeParse({
        name: "Image",
        kind: "image",
        model: "gpt-4.1",
        prompt: "X",
      }).success,
    ).toBe(false);
    expect(
      stepSchema.safeParse({
        name: "Image",
        kind: "image",
        model: "gpt-image-1",
        prompt: "X",
      }).success,
    ).toBe(true);
    expect(
      stepSchema.safeParse({
        name: "Text",
        kind: "text",
        model: "gpt-4.1-mini",
        prompt: "  ",
      }).success,
    ).toBe(false);
  });
  it("rejects duplicate IDs in reorder requests", () => {
    const id = "c41e8d9a-6714-491a-a68f-a324a3d39ebd";
    expect(orderSchema.safeParse({ stepIds: [id, id] }).success).toBe(false);
  });
  it("requires real input and restricts uploaded media types and size", () => {
    expect(runSchema.safeParse({ input: " " }).success).toBe(false);
    expect(
      runSchema.safeParse({ image: "https://example.com/x.png" }).success,
    ).toBe(false);
    expect(
      runSchema.safeParse({ image: "data:image/svg+xml;base64,PHN2Zz4=" })
        .success,
    ).toBe(false);
    expect(runSchema.safeParse({ input: "a".repeat(16001) }).success).toBe(
      false,
    );
  });
});
describe("chain execution", () => {
  it("resolves initial, previous and explicit earlier step references in one pass", () => {
    expect(
      renderPrompt(
        "{{input}} / {{ previous }} / {{step.1}}",
        "photo",
        "{{input}} stays literal",
        ["description"],
      ),
    ).toBe("photo / {{input}} stays literal / description");
    expect(() => renderPrompt("{{step.2}}", "x", "", ["one"])).toThrow(
      "not available",
    );
    expect(() => renderPrompt("{{step.0}}", "x", "", [])).toThrow(
      "not available",
    );
  });
  it("passes visual context and previous output to the text provider", async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "A cheerful cat" } }],
        }),
      ),
    );
    vi.stubGlobal("fetch", mock);
    const result = await generateStep({
      apiKey: "test",
      step,
      prompt: "Describe it",
      previous: "cat photo",
      image: "data:image/png;base64,eA==",
      signal: AbortSignal.timeout(1000),
    });
    expect(result).toEqual({ kind: "text", text: "A cheerful cat" });
    const request = JSON.parse(mock.mock.calls[0][1].body);
    expect(request.messages[0].content[1].image_url.url).toContain(
      "data:image/png",
    );
    expect(request.messages[0].content[0].text).toContain("cat photo");
  });
  it("does not leak provider errors or secret values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("secret=abc", { status: 401 })),
    );
    await expect(
      generateStep({
        apiKey: "test",
        step,
        prompt: "X",
        previous: "",
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow("key was rejected");
  });
  it("rejects empty outputs rather than recording a false success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "" } }] }),
          ),
        ),
    );
    await expect(
      generateStep({
        apiKey: "test",
        step,
        prompt: "X",
        previous: "",
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow("no text");
  });
  it("supports generated image bytes and image edit requests", async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from("png").toString("base64") }],
        }),
      ),
    );
    vi.stubGlobal("fetch", mock);
    const result = await generateStep({
      apiKey: "test",
      step: { ...step, kind: "image", model: "gpt-image-1" },
      prompt: "Draw",
      previous: "cat",
      image: "data:image/png;base64,eA==",
      signal: AbortSignal.timeout(1000),
    });
    expect(result.kind).toBe("image");
    expect(mock.mock.calls[0][0]).toContain("/images/edits");
    expect(mock.mock.calls[0][1].body).toBeInstanceOf(FormData);
  });
});
