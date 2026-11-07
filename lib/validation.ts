import { z } from "zod";
import { getSupportedModelKind } from "./model-catalog";
export { TEXT_MODELS, IMAGE_MODELS } from "./model-catalog";
export const uuid = z.string().uuid();
const chainFields = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    status: z.enum(["draft", "active"]),
  })
  .strict();
export const chainSchema = chainFields.extend({
  description: chainFields.shape.description.default(""),
  status: chainFields.shape.status.default("draft"),
});
export const chainPatchSchema = chainFields
  .partial()
  .refine((v) => Object.keys(v).length > 0, "No changes supplied");
const stepFields = z
  .object({
    name: z.string().trim().min(1).max(100),
    prompt: z
      .string()
      .min(1)
      .max(2000)
      .refine((v) => v.trim().length > 0, "Add a prompt"),
    kind: z.enum(["text", "image"]),
    model: z.string().max(200),
    role: z.enum(["system", "user", "assistant"]).optional(),
    model_id: uuid.nullable().optional(),
  })
  .strict();
function validateFallback(v: z.infer<typeof stepFields>, ctx: z.RefinementCtx) {
  if (getSupportedModelKind(v.model) !== v.kind)
    ctx.addIssue({
      code: "custom",
      path: ["model"],
      message: "Choose a supported workspace model for this output type",
    });
}
export const stepSchema = stepFields.superRefine((v, ctx) => {
  if (v.model_id == null) validateFallback(v, ctx);
});
// Omitted assignments on updates are resolved by the locked database function.
// A registry model may use an unsupported provider while remaining editable.
export const stepUpdateSchema = stepFields.superRefine((v, ctx) => {
  if (v.model_id === null) validateFallback(v, ctx);
});
export const generationStepSchema = stepFields.superRefine((v, ctx) => {
  validateFallback(v, ctx);
});
export const orderSchema = z
  .object({ stepIds: z.array(uuid).max(1000) })
  .strict()
  .refine(
    (v) => new Set(v.stepIds).size === v.stepIds.length,
    "Step IDs must be unique",
  );
export const loginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(512),
  })
  .strict();
export const runSchema = z
  .object({
    input: z.string().trim().max(16000).default(""),
    image: z.string().max(7_000_000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.input && !v.image)
      ctx.addIssue({
        code: "custom",
        message: "Add text or an image to start the chain",
      });
    if (
      v.image &&
      !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v.image)
    )
      ctx.addIssue({
        code: "custom",
        path: ["image"],
        message: "Upload a PNG, JPEG or WebP image under 5 MB",
      });
    if (
      v.image &&
      Buffer.from(v.image.split(",")[1] || "", "base64").length >
        5 * 1024 * 1024
    )
      ctx.addIssue({
        code: "custom",
        path: ["image"],
        message: "Images must be under 5 MB",
      });
  });
