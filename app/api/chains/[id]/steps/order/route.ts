import {
  dbError,
  json,
  parseId,
  readBody,
  requireAdmin,
  route,
} from "@/lib/server";
import { orderSchema } from "@/lib/validation";
export const PUT = route(async (request, { params }) => {
  const { db } = await requireAdmin();
  const id = parseId((await params).id);
  const body = await readBody(request, orderSchema);
  const { data, error } = await db.rpc("reorder_chain_steps", {
    p_chain_id: id,
    p_step_ids: body.stepIds,
  });
  dbError(error, "Could not reorder steps.");
  return json({ steps: data });
});
