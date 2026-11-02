import {
  ApiError,
  dbError,
  json,
  parseId,
  readBody,
  requireAdmin,
  route,
} from "@/lib/server";
import { stepSchema } from "@/lib/validation";
export const PATCH = route(async (request, { params }) => {
  const { db } = await requireAdmin();
  const p = await params;
  const id = parseId(p.id);
  const stepId = parseId(p.stepId);
  const body = await readBody(request, stepSchema);
  const { data, error } = await db
    .from("prompt_chain_steps")
    .update(body)
    .eq("chain_id", id)
    .eq("id", stepId)
    .select()
    .maybeSingle();
  dbError(error, "Could not save this step.");
  if (!data) throw new ApiError(404, "This step no longer exists.");
  const { error: touchError } = await db
    .from("prompt_chains")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);
  dbError(
    touchError,
    "The step was saved, but the chain timestamp could not be updated.",
  );
  return json({ step: data });
});
export const DELETE = route(async (_request, { params }) => {
  const { db } = await requireAdmin();
  const p = await params;
  const id = parseId(p.id);
  const stepId = parseId(p.stepId);
  const { error } = await db.rpc("delete_chain_step", {
    p_chain_id: id,
    p_step_id: stepId,
  });
  dbError(error, "Could not delete this step.");
  return json({ ok: true });
});
