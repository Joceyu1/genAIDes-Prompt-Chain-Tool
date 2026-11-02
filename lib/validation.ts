import { z } from "zod";
export const TEXT_MODELS = ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"] as const;
export const IMAGE_MODELS = ["gpt-image-1"] as const;
export const uuid = z.string().uuid();
const chainFields = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000),
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
export const stepSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(12000),
    kind: z.enum(["text", "image"]),
    model: z.string(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const models: readonly string[] =
      v.kind === "text" ? TEXT_MODELS : IMAGE_MODELS;
    if (!models.includes(v.model))
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: "Choose a supported model for this output type",
      });
  });
export const orderSchema = z
  .object({ stepIds: z.array(uuid).max(30) })
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
