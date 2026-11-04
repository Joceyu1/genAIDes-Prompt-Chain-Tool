import { getRegistryModels } from "@/lib/model-registry";
import { json, requireAdmin, route } from "@/lib/server";

export const GET = route(async () => {
  const { db } = await requireAdmin();
  return json({ models: await getRegistryModels(db) });
});
