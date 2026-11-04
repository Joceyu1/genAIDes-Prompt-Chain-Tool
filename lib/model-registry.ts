import { z } from "zod";
import { ApiError, dbError } from "./server";
import type { ChainStoreDatabase } from "./chain-store";
import type { RegistryModelDescriptor } from "./existing-schema";

const registrySchema = z
  .array(
    z.object({
      id: z.string().uuid(),
      label: z.string().min(1).max(500),
      model: z.string().max(200),
      provider: z.string().max(160),
      kind: z.enum(["text", "image"]).nullish(),
      active: z.boolean(),
    }),
  )
  .max(1000);

/** Read only the model-choice fields exposed by the guarded database bridge. */
export async function getRegistryModels(
  db: ChainStoreDatabase,
): Promise<RegistryModelDescriptor[]> {
  const { data, error } = await db.rpc("chainlab_list_models");
  dbError(error, "Could not load the model registry.");
  const result = registrySchema.safeParse(data);
  if (
    !result.success ||
    new Set(result.data.map((row) => row.id)).size !== result.data.length
  )
    throw new ApiError(
      503,
      "The model registry returned an incompatible result. Ask your administrator to check the database setup.",
    );
  return result.data.map((row) => ({ ...row, kind: row.kind ?? undefined }));
}

/** Editing remains available with unresolved assignments during registry outages. */
export async function getRegistryModelsForEditing(
  db: ChainStoreDatabase,
): Promise<RegistryModelDescriptor[]> {
  try {
    return await getRegistryModels(db);
  } catch (error) {
    if (error instanceof ApiError && [500, 503].includes(error.status))
      return [];
    throw error;
  }
}
