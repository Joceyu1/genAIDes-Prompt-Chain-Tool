import { dbError, json, readBody, requireAdmin, route } from "@/lib/server";
import { chainSchema } from "@/lib/validation";
import type { ChainStep } from "@/lib/types";
export const GET = route(async () => {
  const { db } = await requireAdmin();
  const { data, error } = await db
    .from("prompt_chains")
    .select("*, steps:prompt_chain_steps(*)")
    .order("updated_at", { ascending: false })
    .limit(250);
  dbError(error, "Could not load prompt chains.");
  return json({
    chains: (data || []).map((c) => ({
      ...c,
      steps: (c.steps || []).sort(
        (a: ChainStep, b: ChainStep) => a.position - b.position,
      ),
    })),
  });
});
export const POST = route(async (request) => {
  const { db, user } = await requireAdmin();
  const body = await readBody(request, chainSchema);
  const { data, error } = await db
    .from("prompt_chains")
    .insert({ ...body, created_by: user.id })
    .select()
    .single();
  dbError(error, "Could not create this chain.");
  return json({ chain: { ...data, steps: [] } }, 201);
});
