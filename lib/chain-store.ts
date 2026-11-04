import { z } from "zod";
import {
  adaptExistingChain,
  adaptExistingStep,
  mapChainPatch,
  mapStepPatch,
  type CanonicalChainPatch,
  type CanonicalStepPatch,
  type RegistryModelDescriptor,
} from "./existing-schema";
import { ApiError, dbError } from "./server";
import type { PromptChain } from "./types";

export interface ChainStoreDatabase {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

export interface ChainStoreOptions {
  models?: readonly RegistryModelDescriptor[];
}

const rawChainSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  is_active: z.boolean(),
  source: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
const rawStepSchema = z.object({
  id: z.string().uuid(),
  chain_id: z.string().uuid(),
  position: z.number().int(),
  role: z.string(),
  template: z.string(),
  model_id: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const settingsSchema = z.object({
  step_id: z.string().uuid(),
  name: z.string().nullish(),
  kind: z.enum(["text", "image"]).nullish(),
  fallback_model: z.string().nullish(),
});
const chainSnapshotSchema = z.object({
  chain: rawChainSchema,
  steps: z.array(rawStepSchema),
  settings: z.array(settingsSchema),
});
const listSnapshotSchema = z.object({
  chains: z.array(rawChainSchema),
  steps: z.array(rawStepSchema),
  settings: z.array(settingsSchema),
});
const stepSnapshotSchema = z.object({
  step: rawStepSchema,
  settings: settingsSchema.nullish(),
});

function parseSnapshot<T>(data: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new ApiError(
      503,
      "The Chainlab database returned an incompatible result. Ask your administrator to check the database setup.",
    );
  return parsed.data;
}

function adaptResult<T>(adapt: () => T): T {
  try {
    return adapt();
  } catch {
    throw new ApiError(
      503,
      "The Chainlab database returned inconsistent records. Ask your administrator to check the database setup.",
    );
  }
}

async function callRpc(
  db: ChainStoreDatabase,
  name: string,
  args: Record<string, unknown> | undefined,
  fallback: string,
  foreignKeyMessage?: string,
) {
  const { data, error } = args ? await db.rpc(name, args) : await db.rpc(name);
  dbError(error, fallback, { foreignKeyMessage });
  return data;
}

/** Adapt a single raw RPC snapshot using only explicitly resolved registry rows. */
export function adaptChainSnapshot(
  data: unknown,
  options: ChainStoreOptions = {},
): PromptChain {
  const { chain, steps, settings } = parseSnapshot(data, chainSnapshotSchema);
  return adaptResult(() =>
    adaptExistingChain(chain, {
      steps,
      settings,
      models: options.models,
    }),
  );
}

function adaptExpectedChain(
  data: unknown,
  id: string,
  options: ChainStoreOptions,
): PromptChain {
  const chain = adaptChainSnapshot(data, options);
  if (chain.id !== id)
    throw new ApiError(
      503,
      "The Chainlab database returned a different chain.",
    );
  return chain;
}

export async function listChains(
  db: ChainStoreDatabase,
  options: ChainStoreOptions = {},
): Promise<PromptChain[]> {
  const data = await callRpc(
    db,
    "chainlab_list_chains",
    undefined,
    "Could not load prompt chains.",
  );
  const { chains, steps, settings } = parseSnapshot(data, listSnapshotSchema);
  const chainIds = new Set(chains.map((chain) => chain.id));
  const allStepIds = new Set(steps.map((step) => step.id));
  if (
    chainIds.size !== chains.length ||
    allStepIds.size !== steps.length ||
    steps.some((step) => !chainIds.has(step.chain_id)) ||
    settings.some((setting) => !allStepIds.has(setting.step_id))
  )
    throw new ApiError(
      503,
      "The Chainlab database returned inconsistent chain data.",
    );
  return adaptResult(() =>
    chains.map((chain) => {
      const chainSteps = steps.filter((step) => step.chain_id === chain.id);
      const stepIds = new Set(chainSteps.map((step) => step.id));
      return adaptExistingChain(chain, {
        steps: chainSteps,
        settings: settings.filter((setting) => stepIds.has(setting.step_id)),
        models: options.models,
      });
    }),
  );
}

export async function getChain(
  db: ChainStoreDatabase,
  id: string,
  options: ChainStoreOptions = {},
): Promise<PromptChain> {
  const data = await callRpc(
    db,
    "chainlab_get_chain",
    { p_id: id },
    "Could not load this chain.",
  );
  if (data === null) throw new ApiError(404, "This chain no longer exists.");
  return adaptExpectedChain(data, id, options);
}

export async function createChain(
  db: ChainStoreDatabase,
  input: Pick<PromptChain, "name" | "description" | "status">,
  options: ChainStoreOptions = {},
): Promise<PromptChain> {
  const patch = mapChainPatch(input);
  const data = await callRpc(
    db,
    "chainlab_create_chain",
    {
      p_name: patch.name,
      p_description: patch.description,
      p_is_active: patch.is_active,
    },
    "Could not create this chain.",
  );
  return adaptChainSnapshot(data, options);
}

export async function updateChain(
  db: ChainStoreDatabase,
  id: string,
  patch: CanonicalChainPatch,
  options: ChainStoreOptions = {},
): Promise<PromptChain> {
  const data = await callRpc(
    db,
    "chainlab_update_chain",
    { p_id: id, p_patch: mapChainPatch(patch) },
    "Could not update this chain.",
  );
  return adaptExpectedChain(data, id, options);
}

export async function deleteChain(db: ChainStoreDatabase, id: string) {
  await callRpc(
    db,
    "chainlab_delete_chain",
    { p_id: id },
    "Could not delete this chain.",
    "This chain is used by existing media or mixes and cannot be deleted. Set it to Draft to deactivate it.",
  );
}

function adaptStepSnapshot(
  data: unknown,
  chainId: string,
  options: ChainStoreOptions,
) {
  const { step, settings } = parseSnapshot(data, stepSnapshotSchema);
  if (step.chain_id !== chainId)
    throw new ApiError(
      503,
      "The Chainlab database returned a step from another chain.",
    );
  return adaptResult(() =>
    adaptExistingStep(step, {
      settings: settings ?? undefined,
      model: options.models?.find((model) => model.id === step.model_id),
    }),
  );
}

export async function appendStep(
  db: ChainStoreDatabase,
  chainId: string,
  patch: CanonicalStepPatch,
  options: ChainStoreOptions = {},
) {
  const { step, settings } = mapStepPatch(patch);
  const data = await callRpc(
    db,
    "chainlab_append_step",
    {
      p_chain_id: chainId,
      p_step: {
        ...step,
        role: step.role ?? "user",
        model_id: step.model_id ?? null,
      },
      p_settings: settings,
    },
    "Could not add this step.",
  );
  return adaptStepSnapshot(data, chainId, options);
}

export async function updateStep(
  db: ChainStoreDatabase,
  chainId: string,
  stepId: string,
  patch: CanonicalStepPatch,
  options: ChainStoreOptions = {},
) {
  const { step, settings } = mapStepPatch(patch);
  const data = await callRpc(
    db,
    "chainlab_update_step",
    {
      p_chain_id: chainId,
      p_step_id: stepId,
      p_step: step,
      p_settings: settings,
    },
    "Could not save this step.",
  );
  const result = adaptStepSnapshot(data, chainId, options);
  if (result.id !== stepId)
    throw new ApiError(503, "The Chainlab database returned a different step.");
  return result;
}

export async function deleteStep(
  db: ChainStoreDatabase,
  chainId: string,
  stepId: string,
) {
  await callRpc(
    db,
    "chainlab_delete_step",
    { p_chain_id: chainId, p_step_id: stepId },
    "Could not delete this step.",
  );
}

export async function reorderSteps(
  db: ChainStoreDatabase,
  chainId: string,
  stepIds: readonly string[],
  options: ChainStoreOptions = {},
): Promise<PromptChain> {
  const data = await callRpc(
    db,
    "chainlab_reorder_steps",
    { p_chain_id: chainId, p_step_ids: [...stepIds] },
    "Could not reorder steps.",
  );
  return adaptExpectedChain(data, chainId, options);
}
