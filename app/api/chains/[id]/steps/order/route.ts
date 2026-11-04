import { json, parseId, readBody, requireAdmin, route } from "@/lib/server";
import { orderSchema } from "@/lib/validation";
import { reorderSteps } from "@/lib/chain-store";
import { getRegistryModelsForEditing } from "@/lib/model-registry";
export const PUT = route(async (request, { params }) => {
  const { db } = await requireAdmin();
  const id = parseId((await params).id);
  const body = await readBody(request, orderSchema);
  const models = await getRegistryModelsForEditing(db);
  const chain = await reorderSteps(db, id, body.stepIds, { models });
  return json({ steps: chain.steps });
});
