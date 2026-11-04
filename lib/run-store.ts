import { z } from "zod";
import { ApiError, dbError } from "./server";
import type { ChainStoreDatabase } from "./chain-store";
import type { ChainRun, RunOutput } from "./types";

export const GENERATED_MEDIA_BUCKET = "chainlab-generated-media";

const outputSchema = z.object({
  step_id: z.string().uuid(),
  step_name: z.string(),
  kind: z.enum(["text", "image"]),
  content: z.string(),
  image_path: z.string().optional(),
});
const runSchema = z.object({
  id: z.string().uuid(),
  chain_id: z.string().uuid(),
  status: z.enum(["running", "completed", "failed"]),
  input: z.string(),
  outputs: z.array(outputSchema).max(10),
  error: z.string().nullable(),
  created_at: z.string(),
});

function parseRun(value: unknown, chainId?: string, runId?: string): ChainRun {
  // PostgREST can represent a composite-returning function as one row.
  const parsed = runSchema.safeParse(
    Array.isArray(value) && value.length === 1 ? value[0] : value,
  );
  if (!parsed.success)
    throw new ApiError(
      503,
      "The Chainlab database returned incompatible run history. Ask your administrator to check the database setup.",
    );
  const run = parsed.data;
  if ((chainId && run.chain_id !== chainId) || (runId && run.id !== runId))
    throw new ApiError(503, "The Chainlab database returned a different run.");
  if (
    run.outputs.some((output) =>
      output.kind === "image"
        ? output.content !== "" ||
          output.image_path !==
            `${run.chain_id}/${run.id}/${output.step_id}.png`
        : output.image_path !== undefined,
    )
  )
    throw new ApiError(
      503,
      "The Chainlab database returned an invalid media location.",
    );
  return run;
}

async function call(
  db: ChainStoreDatabase,
  name: string,
  args: Record<string, unknown>,
  fallback: string,
) {
  const { data, error } = await db.rpc(name, args);
  if (error?.code === "55000")
    throw new ApiError(
      409,
      "This run has already finished. Refresh to view its saved result.",
    );
  if (error?.code === "P0002")
    throw new ApiError(404, "This chain or run no longer exists.");
  dbError(error, fallback);
  return data;
}

export async function listRuns(
  db: ChainStoreDatabase,
  chainId: string,
): Promise<ChainRun[]> {
  const data = await call(
    db,
    "chainlab_list_runs",
    { p_chain_id: chainId },
    "Could not load generated media.",
  );
  if (!Array.isArray(data) || data.length > 50)
    throw new ApiError(
      503,
      "The Chainlab database returned incompatible run history.",
    );
  const runs = data.map((run) => parseRun(run, chainId));
  if (new Set(runs.map((run) => run.id)).size !== runs.length)
    throw new ApiError(
      503,
      "The Chainlab database returned duplicate run history.",
    );
  return runs;
}

export async function createRun(
  db: ChainStoreDatabase,
  chainId: string,
  input: string,
): Promise<ChainRun> {
  return parseRun(
    await call(
      db,
      "chainlab_create_run",
      { p_chain_id: chainId, p_input: input },
      "Could not start this run.",
    ),
    chainId,
  );
}

export async function updateRun(
  db: ChainStoreDatabase,
  run: Pick<ChainRun, "id" | "chain_id">,
  status: ChainRun["status"],
  outputs: RunOutput[],
  error: string | null = null,
): Promise<ChainRun> {
  return parseRun(
    await call(
      db,
      "chainlab_update_run",
      {
        p_run_id: run.id,
        p_status: status,
        p_outputs: outputs,
        p_error: error,
      },
      "Run progress could not be saved.",
    ),
    run.chain_id,
    run.id,
  );
}
