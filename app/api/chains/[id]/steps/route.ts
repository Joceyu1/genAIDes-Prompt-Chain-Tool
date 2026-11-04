import { json, parseId, readBody, requireAdmin, route } from "@/lib/server";
import { stepSchema } from "@/lib/validation";
import { appendStep } from "@/lib/chain-store";
import { getRegistryModelsForEditing } from "@/lib/model-registry";
export const POST = route(async (request, { params }) => {
  const { db } = await requireAdmin();
  const id = parseId((await params).id);
  const body = await readBody(request, stepSchema);
  const models = await getRegistryModelsForEditing(db);
  return json({ step: await appendStep(db, id, body, { models }) }, 201);
});
