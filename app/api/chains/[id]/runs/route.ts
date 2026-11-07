import {
  ApiError,
  dbError,
  json,
  parseId,
  readBody,
  requireAdmin,
  route,
  supabaseServer,
} from "@/lib/server";
import { runSchema, generationStepSchema } from "@/lib/validation";
import {
  GenerationError,
  generateStep,
  getGenerationProvider,
  renderPrompt,
} from "@/lib/generation";
import type { ChainRun, RunOutput } from "@/lib/types";
import { randomUUID } from "node:crypto";
import { getChain } from "@/lib/chain-store";
import { getRegistryModels } from "@/lib/model-registry";
import { listLegacyHistory } from "@/lib/legacy-history";
import {
  createRun,
  updateRun,
  listRuns,
  GENERATED_MEDIA_BUCKET,
} from "@/lib/run-store";
export const runtime = "nodejs";
export const maxDuration = 300;

async function withSignedImages(
  db: Awaited<ReturnType<typeof supabaseServer>>,
  run: ChainRun,
): Promise<ChainRun> {
  const outputs = await Promise.all(
    (run.outputs || []).map(async (output) => {
      if (!output.image_path) return output;
      try {
        const { data, error } = await db.storage
          .from(GENERATED_MEDIA_BUCKET)
          .createSignedUrl(output.image_path, 3600);
        // Preserve the other outputs when an image was removed or is unavailable.
        return { ...output, content: error ? "" : data?.signedUrl || "" };
      } catch {
        return { ...output, content: "" };
      }
    }),
  );
  return { ...run, outputs };
}
// Check the actual authenticated Storage permissions before paying for images.
// The probe contains no user content and is always removed through the Storage API.
async function checkImageStorage(
  db: Awaited<ReturnType<typeof supabaseServer>>,
  chainId: string,
) {
  const bucket = db.storage.from(GENERATED_MEDIA_BUCKET);
  const path = `${chainId}/.checks/${randomUUID()}.png`;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
    "base64",
  );
  let uploaded = false;
  let ready = false;
  try {
    const { error: uploadError } = await bucket.upload(path, png, {
      contentType: "image/png",
      upsert: false,
    });
    if (!uploadError) {
      uploaded = true;
      const { data, error } = await bucket.createSignedUrl(path, 60);
      ready = !error && !!data?.signedUrl;
    }
  } catch {
    ready = false;
  } finally {
    if (uploaded) {
      try {
        const { data, error } = await bucket.remove([path]);
        if (error || !data?.some((object) => object.name === path))
          ready = false;
      } catch {
        ready = false;
      }
    }
  }
  if (!ready)
    throw new ApiError(
      503,
      "Private image storage is not available for this account yet. Ask your administrator to complete the Chainlab storage setup.",
    );
}

export const GET = route(async (_request, { params }) => {
  const { db } = await requireAdmin();
  const id = parseId((await params).id);
  const [runs, legacy] = await Promise.all([
    listRuns(db, id),
    listLegacyHistory(db, id),
  ]);
  return json({
    runs: await Promise.all(runs.map((run) => withSignedImages(db, run))),
    legacy,
  });
});
export const POST = route(async (request, { params }) => {
  const { db } = await requireAdmin();
  const id = parseId((await params).id);
  const body = await readBody(request, runSchema, 7_100_000);
  const models = await getRegistryModels(db);
  const { steps } = await getChain(db, id, { models });
  if (!steps.length)
    throw new ApiError(400, "Add a step before running this chain.");
  if (steps.length > 10)
    throw new ApiError(
      400,
      "A run supports up to 10 steps. Split this chain before running it.",
    );
  for (const step of steps) {
    if (
      step.generation_ready === false ||
      !generationStepSchema.safeParse({
        name: step.name,
        prompt: step.prompt,
        model: step.model,
        kind: step.kind,
        role: step.role,
        model_id: step.model_id,
      }).success
    )
      throw new ApiError(
        400,
        `Check the model and prompt for step “${step.name}” before running.`,
      );
  }
  // Resolve every step and credential before storage probes, history or any
  // provider call. An unavailable provider never triggers a paid fallback.
  const providerKeys = {
    gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    openai: process.env.AI_API_KEY || process.env.OPENAI_API_KEY,
  };
  const preparedSteps = steps.map((step) => {
    let provider;
    try {
      provider = getGenerationProvider(step);
    } catch (error) {
      if (error instanceof GenerationError)
        throw new ApiError(400, error.message);
      throw error;
    }
    const apiKey = providerKeys[provider];
    if (!apiKey)
      throw new ApiError(
        503,
        provider === "gemini"
          ? "Gemini generation is not configured yet. Ask your administrator to connect a Gemini API key."
          : "OpenAI generation is not configured yet. Ask your administrator to connect an OpenAI API key.",
      );
    return { step, apiKey };
  });
  if (steps.some((step) => step.kind === "image"))
    await checkImageStorage(db, id);
  const created = await createRun(db, id, body.input || "(Image input)");
  const outputs: RunOutput[] = [];
  const texts: string[] = [];
  let previous = body.input;
  let currentImage = body.image;
  const signal = AbortSignal.timeout(250_000);
  try {
    for (const { step, apiKey } of preparedSteps) {
      const prompt = renderPrompt(step.prompt, body.input, previous, texts);
      const generated = await generateStep({
        apiKey,
        step,
        prompt,
        previous,
        image: currentImage,
        signal,
      });
      if (generated.kind === "text") {
        outputs.push({
          step_id: step.id,
          step_name: step.name,
          kind: "text",
          content: generated.text,
        });
        previous = generated.text;
        texts.push(previous);
        // Retain the original visual context across text steps so later steps can refer to it.
      } else {
        const imagePath = `${id}/${created.id}/${step.id}.png`;
        const { error: uploadError } = await db.storage
          .from(GENERATED_MEDIA_BUCKET)
          .upload(imagePath, generated.bytes, {
            contentType: generated.mime,
            upsert: false,
          });
        dbError(uploadError, "The generated image could not be saved.");
        outputs.push({
          step_id: step.id,
          step_name: step.name,
          kind: "image",
          content: "",
          image_path: imagePath,
        });
        currentImage = `data:${generated.mime};base64,${generated.bytes.toString("base64")}`;
        previous = `[Image generated by ${step.name}]`;
        texts.push(previous);
      }
      await updateRun(db, created, "running", outputs);
    }
    const completed = await updateRun(db, created, "completed", outputs);
    return json({ run: await withSignedImages(db, completed) }, 201);
  } catch (error) {
    const message = signal.aborted
      ? "This run reached its time limit. Try a shorter chain."
      : error instanceof ApiError
        ? error.message
        : error instanceof GenerationError
          ? error.message
          : "The AI provider could not be reached. Please try again.";
    let failed: ChainRun | null = null;
    try {
      failed = await updateRun(
        db,
        created,
        "failed",
        outputs,
        message.slice(0, 1000),
      );
    } catch (saveError) {
      console.error("Failed run status could not be saved", {
        type: saveError instanceof Error ? saveError.name : "UnknownError",
      });
    }
    return json(
      {
        error: message,
        run: await withSignedImages(
          db,
          failed || { ...created, status: "failed", outputs, error: message },
        ),
      },
      502,
    );
  }
});
