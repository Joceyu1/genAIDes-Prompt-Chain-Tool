import type { ChainStep, PromptChain, StepKind } from "./types";
import { IMAGE_MODELS, TEXT_MODELS } from "./validation";

/** The existing shared tables, without app-specific columns or defaults. */
export interface ExistingPromptChainRecord {
  id: string;
  created_at: string;
  updated_at: string;
  name: string;
  description: string;
  is_active: boolean;
  source: string;
}

export interface ExistingChainStepRecord {
  id: string;
  created_at: string;
  updated_at: string;
  chain_id: string;
  position: number;
  role: string;
  template: string;
  model_id: string | null;
}

/** Optional app-owned presentation and generation settings for one step. */
export interface ExistingStepSettingsRecord {
  step_id: string;
  name?: string | null;
  kind?: StepKind | null;
  fallback_model?: string | null;
}

/** A registry row resolved by the database bridge, never a guessed UUID mapping. */
export interface RegistryModelDescriptor {
  id: string;
  label: string;
  model: string;
  provider: string;
  kind?: StepKind;
}

export interface ExistingStepAdaptation {
  settings?: ExistingStepSettingsRecord;
  model?: RegistryModelDescriptor;
}

export interface ExistingChainAdaptation {
  steps?: readonly ExistingChainStepRecord[];
  settings?: readonly ExistingStepSettingsRecord[];
  models?: readonly RegistryModelDescriptor[];
}

function supportedModelKind(model: string): StepKind | undefined {
  if ((TEXT_MODELS as readonly string[]).includes(model)) return "text";
  if ((IMAGE_MODELS as readonly string[]).includes(model)) return "image";
}

export function adaptExistingStep(
  record: ExistingChainStepRecord,
  { settings, model }: ExistingStepAdaptation = {},
): ChainStep {
  if (settings && settings.step_id !== record.id)
    throw new Error("Step settings do not match this step's ID.");
  if (model && model.id !== record.model_id)
    throw new Error("The registry model does not match this step's model ID.");

  const kind =
    settings?.kind ??
    model?.kind ??
    (model ? supportedModelKind(model.model) : undefined) ??
    "text";
  const name = settings?.name?.trim()
    ? settings.name
    : `Step ${record.position}`;
  let providerModel = "";
  let modelLabel = "Assigned model";
  let generationReady = false;

  if (record.model_id === null) {
    // A fallback never replaces an assigned registry UUID.
    const fallback = settings?.fallback_model;
    providerModel =
      fallback && supportedModelKind(fallback) === kind
        ? fallback
        : kind === "image"
          ? "gpt-image-1"
          : "gpt-4.1-mini";
    modelLabel = providerModel;
    generationReady = true;
  } else if (model) {
    providerModel = model.model;
    modelLabel = model.label;
    generationReady =
      model.provider.toLowerCase() === "openai" &&
      supportedModelKind(providerModel) === kind &&
      (model.kind === undefined || model.kind === kind);
  }

  return {
    id: record.id,
    chain_id: record.chain_id,
    position: record.position,
    created_at: record.created_at,
    updated_at: record.updated_at,
    role: record.role,
    model_id: record.model_id,
    name,
    prompt: record.template,
    kind,
    model: providerModel,
    model_label: modelLabel,
    generation_ready: generationReady,
  };
}

function indexUnique<T>(
  records: readonly T[],
  key: (record: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const record of records) {
    const id = key(record);
    if (result.has(id)) throw new Error(`Duplicate ${label} ID.`);
    result.set(id, record);
  }
  return result;
}

export function adaptExistingChain(
  record: ExistingPromptChainRecord,
  { steps = [], settings = [], models = [] }: ExistingChainAdaptation = {},
): PromptChain {
  const settingsByStep = indexUnique(
    settings,
    (item) => item.step_id,
    "settings",
  );
  const modelsById = indexUnique(models, (item) => item.id, "registry model");
  indexUnique(steps, (item) => item.id, "step");
  const adaptedSteps = steps.map((step) => {
    if (step.chain_id !== record.id)
      throw new Error("The step does not belong to this chain.");
    return adaptExistingStep(step, {
      settings: settingsByStep.get(step.id),
      model: step.model_id === null ? undefined : modelsById.get(step.model_id),
    });
  });
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    status: record.is_active ? "active" : "draft",
    created_at: record.created_at,
    updated_at: record.updated_at,
    source: record.source,
    steps: adaptedSteps.sort((a, b) => a.position - b.position),
  };
}

export type CanonicalChainPatch = Partial<
  Pick<PromptChain, "name" | "description" | "status">
>;
export type ExistingChainPatch = Partial<
  Pick<ExistingPromptChainRecord, "name" | "description" | "is_active">
>;

/** Map validated edits only; source, IDs and timestamps remain database-owned. */
export function mapChainPatch(patch: CanonicalChainPatch): ExistingChainPatch {
  const result: ExistingChainPatch = {};
  if (patch.name !== undefined) result.name = patch.name;
  if (patch.description !== undefined) result.description = patch.description;
  if (patch.status !== undefined) result.is_active = patch.status === "active";
  return result;
}

export type CanonicalStepPatch = Partial<
  Pick<ChainStep, "name" | "prompt" | "kind" | "model" | "role" | "model_id">
>;
export interface ExistingStepPatch {
  step: Partial<
    Pick<ExistingChainStepRecord, "template" | "role" | "model_id">
  >;
  settings: Partial<
    Pick<ExistingStepSettingsRecord, "name" | "kind" | "fallback_model">
  >;
}

/** Omitted model_id preserves the registry assignment; explicit null clears it. */
export function mapStepPatch(patch: CanonicalStepPatch): ExistingStepPatch {
  const step: ExistingStepPatch["step"] = {};
  const settings: ExistingStepPatch["settings"] = {};
  if (patch.prompt !== undefined) step.template = patch.prompt;
  if (patch.role !== undefined) step.role = patch.role;
  if (patch.model_id !== undefined) step.model_id = patch.model_id;
  if (patch.name !== undefined) settings.name = patch.name;
  if (patch.kind !== undefined) settings.kind = patch.kind;
  if (patch.model !== undefined) settings.fallback_model = patch.model;
  return { step, settings };
}
