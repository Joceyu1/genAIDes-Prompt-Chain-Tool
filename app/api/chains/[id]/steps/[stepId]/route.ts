import { json, parseId, readBody, requireAdmin, route } from "@/lib/server";
import { stepUpdateSchema } from "@/lib/validation";
import { deleteStep, updateStep } from "@/lib/chain-store";
import { getRegistryModelsForEditing } from "@/lib/model-registry";
export const PATCH = route(async (request, { params }) => {
  const { db } = await requireAdmin();
  const p = await params;
  const id = parseId(p.id);
  const stepId = parseId(p.stepId);
  const body = await readBody(request, stepUpdateSchema);
  const models = await getRegistryModelsForEditing(db);
  return json({ step: await updateStep(db, id, stepId, body, { models }) });
});
export const DELETE = route(async (_request, { params }) => {
  const { db } = await requireAdmin();
  const p = await params;
  const id = parseId(p.id);
  const stepId = parseId(p.stepId);
  await deleteStep(db, id, stepId);
  return json({ ok: true });
});
