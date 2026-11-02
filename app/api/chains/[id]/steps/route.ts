import {
  dbError,
  json,
  parseId,
  readBody,
  requireAdmin,
  route,
} from "@/lib/server";
import { stepSchema } from "@/lib/validation";
export const POST = route(async (request, { params }) => {
  const { db } = await requireAdmin();
  const id = parseId((await params).id);
  const body = await readBody(request, stepSchema);
  const { data, error } = await db.rpc("append_chain_step", {
    p_chain_id: id,
    p_name: body.name,
    p_prompt: body.prompt,
    p_kind: body.kind,
    p_model: body.model,
  });
  dbError(error, "Could not add this step.");
  return json({ step: data }, 201);
});
