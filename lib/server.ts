import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { z } from "zod";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function supabaseServer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    throw new ApiError(
      503,
      "Authentication is not configured yet. Please contact your administrator.",
    );
  const jar = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (values) => {
        for (const { name, value, options } of values)
          jar.set(name, value, {
            ...options,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
          });
      },
    },
  });
}
export async function requireAdmin() {
  const db = await supabaseServer();
  const {
    data: { user },
    error,
  } = await db.auth.getUser();
  if (error || !user) throw new ApiError(401, "Sign in to continue.");
  await verifySuperadmin(db);
  return { db, user };
}
export async function verifySuperadmin(
  db: Awaited<ReturnType<typeof supabaseServer>>,
) {
  // The function checks only auth.uid(). Direct profile reads can be hidden by
  // an unrelated application's restrictive domain policy in the shared project.
  const { data: isSuperadmin, error } = await db.rpc("chainlab_is_superadmin");
  if (error) {
    console.error("Administrator check failed", {
      code: error.code,
    });
    throw new ApiError(
      503,
      "Your login succeeded, but the administrator check could not run. The project administrator needs to check the Chainlab database setup.",
    );
  }
  if (isSuperadmin !== true)
    throw new ApiError(403, "This workspace is available to superadmins only.");
}
export const json = (value: unknown, status = 200) =>
  NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
export function requestOrigin(request: Request) {
  const url = new URL(request.url);
  // Next's bind address can be 0.0.0.0 in local production mode. Use the
  // browser-controlled Host header, never an untrusted forwarded-host header.
  const host = request.headers.get("host");
  if (!host) return url.origin;
  if (/[\s\\/\@,?#]/.test(host))
    throw new ApiError(400, "Invalid request host.");
  try {
    return new URL(`${url.protocol}//${host}`).origin;
  } catch {
    throw new ApiError(400, "Invalid request host.");
  }
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== requestOrigin(request))
    throw new ApiError(403, "This request must come from this application.");
}
export async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes = 100_000,
): Promise<T> {
  if (Number(request.headers.get("content-length") || 0) > maxBytes)
    throw new ApiError(413, "The request is too large.");
  // Enforce a streaming limit as content-length may be absent or untrusted.
  if (!request.body)
    throw new ApiError(400, "A JSON request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, "The request is too large.");
    }
    chunks.push(value);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "Invalid JSON request.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(
      400,
      parsed.error.issues[0]?.message || "Invalid request.",
    );
  return parsed.data;
}
export function dbError(
  error: { code?: string; message?: string } | null,
  fallback: string,
  options: { foreignKeyMessage?: string } = {},
) {
  if (!error) return;
  if (error.code === "23505")
    throw new ApiError(
      409,
      error.message?.includes('"prompt_chains_name_key"')
        ? "A chain with this name already exists."
        : "This data changed while you were editing. Refresh and try again.",
    );
  if (error.code === "P0002")
    throw new ApiError(404, "This chain or step no longer exists.");
  if (error.code === "23001" || error.code === "23503")
    throw new ApiError(
      409,
      options.foreignKeyMessage ||
        "A referenced record is missing or still in use. Refresh and try again.",
    );
  if (
    error.code === "22023" &&
    [
      "Reordering 1000 occupied positions needs a free slot; remove a step first",
      "This chain has reached the 1000-step position limit",
    ].includes(error.message || "")
  )
    throw new ApiError(400, error.message!);
  if (error.code === "22023" || error.code === "23514")
    throw new ApiError(
      400,
      "The requested change is invalid. Refresh and try again.",
    );
  if (error.code === "42501")
    throw new ApiError(403, "You do not have access to this action.");
  if (error.code === "PGRST202" || error.code === "42883")
    throw new ApiError(
      503,
      "The Chainlab database setup is incomplete. Ask your administrator to apply the shared-database setup.",
    );
  console.error(fallback, { code: error.code });
  throw new ApiError(500, fallback);
}
export function route(
  handler: (
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ) => Promise<Response>,
) {
  return async (
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) checkOrigin(request);
      return await handler(request, context);
    } catch (error) {
      if (error instanceof ApiError)
        return json({ error: error.message }, error.status);
      console.error("API request failed", {
        type: error instanceof Error ? error.name : "UnknownError",
      });
      return json(
        { error: "The request could not be completed. Please try again." },
        500,
      );
    }
  };
}
export async function chainExists(
  db: Awaited<ReturnType<typeof supabaseServer>>,
  id: string,
) {
  const { data, error } = await db.rpc("chainlab_get_chain", { p_id: id });
  dbError(error, "Could not load this chain.");
  if (!data?.chain) throw new ApiError(404, "This chain no longer exists.");
  if (data.chain.id !== id)
    throw new ApiError(
      503,
      "The Chainlab database returned a different chain.",
    );
}
export function parseId(value: string | undefined) {
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new ApiError(400, "Invalid resource ID.");
  return value;
}
