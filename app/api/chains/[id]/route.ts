import { json, parseId, readBody, requireAdmin, route } from "@/lib/server";
import { chainPatchSchema } from "@/lib/validation";
import { deleteChain, getChain, updateChain } from "@/lib/chain-store";
import { getRegistryModelsForEditing } from "@/lib/model-registry";
export const GET = route(async (_request, { params }) => {
  const { db } = await requireAdmin();
  const id = parseId((await params).id);
  const models = await getRegistryModelsForEditing(db);
  return json({ chain: await getChain(db, id, { models }) });
});
export const PATCH = route(async (request, { params }) => {
  const { db } = await requireAdmin();
  const id = parseId((await params).id);
  const body = await readBody(request, chainPatchSchema);
  const models = await getRegistryModelsForEditing(db);
  return json({ chain: await updateChain(db, id, body, { models }) });
});
export const DELETE = route(async (_request, { params }) => {
  const { db } = await requireAdmin();
  const id = parseId((await params).id);
  await deleteChain(db, id);
  return json({ ok: true });
});
