import { describe, expect, it } from "vitest";
import {
  adaptExistingChain,
  adaptExistingStep,
  mapChainPatch,
  mapStepPatch,
  type ExistingChainStepRecord,
  type ExistingPromptChainRecord,
  type ExistingStepSettingsRecord,
  type RegistryModelDescriptor,
} from "../lib/existing-schema";

const chain: ExistingPromptChainRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  created_at: "2026-10-01T12:00:00+00:00",
  updated_at: "2026-11-04T12:00:00+00:00",
  name: "Existing captions",
  description: "Preserve the shared assignment data",
  is_active: true,
  source: "source_snapshot",
};
const step: ExistingChainStepRecord = {
  id: "22222222-2222-4222-8222-222222222222",
  created_at: "2026-10-01T12:00:00+00:00",
  updated_at: "2026-10-02T12:00:00+00:00",
  chain_id: chain.id,
  position: 12,
  role: "system",
  template: "Describe {{input}} before writing captions.",
  model_id: "33333333-3333-4333-8333-333333333333",
};
const model: RegistryModelDescriptor = {
  id: step.model_id!,
  label: "Studio text model",
  model: "gpt-4.1-mini",
  provider: "openai",
  kind: "text",
};

describe("adapting the existing shared prompt chain tables", () => {
  it("maps the actual columns while preserving IDs, source, role, template and timestamps", () => {
    const result = adaptExistingChain(chain, {
      steps: [step],
      models: [model],
    });
    expect(result).toMatchObject({
      id: chain.id,
      name: chain.name,
      description: chain.description,
      status: "active",
      source: chain.source,
      created_at: chain.created_at,
      updated_at: chain.updated_at,
      steps: [
        {
          id: step.id,
          chain_id: chain.id,
          name: "Step 12",
          prompt: step.template,
          role: "system",
          position: 12,
          model_id: step.model_id,
          model: "gpt-4.1-mini",
          model_label: "Studio text model",
          generation_ready: true,
          created_at: step.created_at,
          updated_at: step.updated_at,
        },
      ],
    });
    expect(adaptExistingChain({ ...chain, is_active: false }).status).toBe(
      "draft",
    );
  });

  it("sorts numerically without mutating records or renumbering existing positions", () => {
    const early = {
      ...step,
      id: "44444444-4444-4444-8444-444444444444",
      position: 2,
    };
    const steps = [Object.freeze(step), Object.freeze(early)];
    const original = structuredClone(steps);
    const result = adaptExistingChain(Object.freeze(chain), { steps });
    expect(result.steps.map((item) => item.position)).toEqual([2, 12]);
    expect(steps).toEqual(original);
    expect(steps[0]).toBe(step);
  });

  it("never treats an unresolved registry UUID or a fallback as the assigned provider model", () => {
    const result = adaptExistingStep(step, {
      settings: { step_id: step.id, fallback_model: "gpt-4.1" },
    });
    expect(result).toMatchObject({
      model_id: step.model_id,
      model: "",
      model_label: "Assigned model",
      generation_ready: false,
      role: "system",
    });
  });

  it.each([
    { provider: "anthropic", model: "claude-sonnet", label: "Assigned Claude" },
    { provider: "anthropic", model: "gpt-4.1-mini", label: "Other provider" },
    {
      provider: "openai",
      model: "unrecognized-openai-model",
      label: "Future model",
    },
  ])(
    "preserves unsupported registry model edits without enabling generation: $label",
    (override) => {
      const descriptor = { ...model, ...override };
      expect(adaptExistingStep(step, { model: descriptor })).toMatchObject({
        model_id: step.model_id,
        model: descriptor.model,
        model_label: descriptor.label,
        generation_ready: false,
      });
    },
  );

  it.each(["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"])(
    "supports the known OpenAI text model %s",
    (key) => {
      expect(
        adaptExistingStep(step, { model: { ...model, model: key } })
          .generation_ready,
      ).toBe(true);
    },
  );

  it("uses registry output kind when available and rejects incompatible output settings", () => {
    const imageModel: RegistryModelDescriptor = {
      ...model,
      label: "Studio image model",
      model: "gpt-image-1",
      kind: "image",
      provider: "OpenAI",
    };
    expect(adaptExistingStep(step, { model: imageModel })).toMatchObject({
      kind: "image",
      model: "gpt-image-1",
      generation_ready: true,
    });
    expect(
      adaptExistingStep(step, {
        model: imageModel,
        settings: { step_id: step.id, kind: "text" },
      }),
    ).toMatchObject({ kind: "text", generation_ready: false });
    expect(
      adaptExistingStep(step, {
        model: { ...model, kind: "image" },
      }).generation_ready,
    ).toBe(false);
  });

  it("infers a supported registry model kind without inventing a stored role", () => {
    expect(
      adaptExistingStep(
        { ...step, role: "custom-existing-role" },
        { model: { ...model, kind: undefined, model: "gpt-image-1" } },
      ),
    ).toMatchObject({
      kind: "image",
      role: "custom-existing-role",
      generation_ready: true,
    });
  });

  it.each([
    { settings: undefined, kind: "text", model: "gpt-4.1-mini" },
    { settings: { kind: "image" }, kind: "image", model: "gpt-image-1" },
    { settings: { fallback_model: "gpt-4.1" }, kind: "text", model: "gpt-4.1" },
    {
      settings: { fallback_model: "unknown" },
      kind: "text",
      model: "gpt-4.1-mini",
    },
    {
      settings: { kind: "image", fallback_model: "gpt-4.1" },
      kind: "image",
      model: "gpt-image-1",
    },
  ] as const)(
    "uses only a compatible fallback when model_id is null: $model",
    (fixture) => {
      const settings: ExistingStepSettingsRecord | undefined = fixture.settings
        ? { step_id: step.id, ...fixture.settings }
        : undefined;
      expect(
        adaptExistingStep({ ...step, model_id: null }, { settings }),
      ).toMatchObject({
        model_id: null,
        kind: fixture.kind,
        model: fixture.model,
        generation_ready: true,
      });
    },
  );

  it("keeps explicitly supplied display names and falls back for empty sidecar names", () => {
    expect(
      adaptExistingStep(step, {
        settings: { step_id: step.id, name: "Describe image" },
      }).name,
    ).toBe("Describe image");
    expect(
      adaptExistingStep(step, { settings: { step_id: step.id, name: "  " } })
        .name,
    ).toBe("Step 12");
  });

  it("rejects mismatched or duplicate metadata IDs instead of applying another row's data", () => {
    expect(() =>
      adaptExistingStep(step, {
        settings: { step_id: chain.id, name: "Wrong" },
      }),
    ).toThrow("settings do not match");
    expect(() =>
      adaptExistingStep(step, { model: { ...model, id: chain.id } }),
    ).toThrow("registry model does not match");
    expect(() =>
      adaptExistingChain(chain, { steps: [{ ...step, chain_id: step.id }] }),
    ).toThrow("does not belong");
    expect(() => adaptExistingChain(chain, { steps: [step, step] })).toThrow(
      "Duplicate step ID",
    );
    expect(() => adaptExistingChain(chain, { models: [model, model] })).toThrow(
      "Duplicate registry model ID",
    );
    expect(() =>
      adaptExistingChain(chain, {
        settings: [{ step_id: step.id }, { step_id: step.id }],
      }),
    ).toThrow("Duplicate settings ID");
  });
});

describe("mapping edits without replacing existing database fields", () => {
  it("maps only provided chain changes and leaves source and database-owned fields out", () => {
    expect(mapChainPatch({ name: "Renamed" })).toEqual({ name: "Renamed" });
    expect(mapChainPatch({ status: "draft", description: "" })).toEqual({
      is_active: false,
      description: "",
    });
    expect(mapChainPatch({ status: "active" })).toEqual({ is_active: true });
    expect(mapChainPatch({ ...chain, status: "active" })).toEqual({
      name: chain.name,
      description: chain.description,
      is_active: true,
    });
  });

  it("separates actual step columns from app-owned settings", () => {
    expect(
      mapStepPatch({
        prompt: "Updated {{previous}}",
        role: "user",
        name: "New label",
        kind: "image",
        model: "gpt-image-1",
      }),
    ).toEqual({
      step: { template: "Updated {{previous}}", role: "user" },
      settings: {
        name: "New label",
        kind: "image",
        fallback_model: "gpt-image-1",
      },
    });
  });

  it("preserves an omitted registry assignment and distinguishes explicit UUID and null edits", () => {
    const unchangedAssignment = mapStepPatch({
      prompt: "Only edit the prompt",
    });
    expect(unchangedAssignment.step).not.toHaveProperty("model_id");
    expect(mapStepPatch({ model_id: undefined }).step).not.toHaveProperty(
      "model_id",
    );
    expect(mapStepPatch({ model: "gpt-4.1" }).step).not.toHaveProperty(
      "model_id",
    );
    expect(mapStepPatch({ model_id: model.id }).step).toEqual({
      model_id: model.id,
    });
    expect(mapStepPatch({ model_id: null }).step).toEqual({ model_id: null });
    expect(mapStepPatch({ name: "Only edit the label" }).step).toEqual({});
  });
});
