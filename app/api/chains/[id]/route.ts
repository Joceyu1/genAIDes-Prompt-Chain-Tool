import {
  ApiError,
  dbError,
  json,
  parseId,
  readBody,
  requireAdmin,
  route,
} from "@/lib/server";
import { chainPatchSchema } from "@/lib/validation";
import type { ChainStep } from "@/lib/types";
export const PATCH = route(async (request, { params }) => {
  const { db } = await requireAdmin();
  const id = parseId((await params).id);
  const body = await readBody(request, chainPatchSchema);
  const { data, error } = await db
    .from("prompt_chains")
    .update(body)
    .eq("id", id)
    .select("*, steps:prompt_chain_steps(*)")
    .maybeSingle();
  dbError(error, "Could not update this chain.");
  if (!data) throw new ApiError(404, "This chain no longer exists.");
  return json({
    chain: {
      ...data,
      steps: (data.steps || []).sort(
        (a: ChainStep, b: ChainStep) => a.position - b.position,
      ),
    },
  });
});
export const DELETE = route(async (_request, { params }) => {
  const { db } = await requireAdmin();
  const id = parseId((await params).id);
  const { data, error } = await db
    .from("prompt_chains")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();
  dbError(error, "Could not delete this chain.");
  if (!data) throw new ApiError(404, "This chain no longer exists.");
  return json({ ok: true });
});
