import { json, readBody, requireAdmin, route } from "@/lib/server";
import { chainSchema } from "@/lib/validation";
import { createChain, listChains } from "@/lib/chain-store";
import { getRegistryModelsForEditing } from "@/lib/model-registry";
export const GET = route(async () => {
  const { db } = await requireAdmin();
  const models = await getRegistryModelsForEditing(db);
  return json({ chains: await listChains(db, { models }) });
});
export const POST = route(async (request) => {
  const { db } = await requireAdmin();
  const body = await readBody(request, chainSchema);
  const models = await getRegistryModelsForEditing(db);
  return json({ chain: await createChain(db, body, { models }) }, 201);
});
