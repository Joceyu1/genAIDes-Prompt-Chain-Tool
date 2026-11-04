import { z } from "zod";
import type { ChainStoreDatabase } from "./chain-store";
import { ApiError, dbError } from "./server";

const entrySchema = z.object({
  source: z.enum(["saved_example", "generation_request"]),
  id: z.string().uuid(),
  chain_id: z.string().uuid(),
  created_at: z.string(),
  prompt: z.string().max(16000),
  status: z.string().max(200),
  output: z.string().max(20000).nullable(),
  title: z.string().max(2000).nullable(),
  caption: z.string().max(20000).nullable(),
  model: z.string().max(200).nullable(),
  origin: z.string().max(200).nullable(),
  generation_prompt: z.string().max(16000).nullable(),
  generation_status: z.string().max(200).nullable(),
  truncated: z.boolean(),
});
export type LegacyHistoryItem = z.infer<typeof entrySchema>;

/** Read-only projection of the assignment's saved text; never infer media URLs. */
export async function listLegacyHistory(
  db: ChainStoreDatabase,
  chainId: string,
): Promise<LegacyHistoryItem[]> {
  const { data, error } = await db.rpc("chainlab_list_legacy_history", {
    p_chain_id: chainId,
  });
  dbError(error, "Could not load saved history.");
  const parsed = z.array(entrySchema).max(50).safeParse(data);
  if (
    !parsed.success ||
    parsed.data.some((entry) => entry.chain_id !== chainId) ||
    new Set(parsed.data.map((entry) => `${entry.source}:${entry.id}`)).size !==
      parsed.data.length
  )
    throw new ApiError(
      503,
      "The database returned incompatible saved history. Ask your administrator to check the Chainlab setup.",
    );
  return parsed.data;
}
