import {
  ApiError,
  json,
  readBody,
  route,
  supabaseServer,
  verifySuperadmin,
} from "@/lib/server";
import { loginSchema } from "@/lib/validation";
export const POST = route(async (request) => {
  const body = await readBody(request, loginSchema);
  const db = await supabaseServer();
  const { data, error } = await db.auth.signInWithPassword(body);
  if (error || !data.user) {
    if (error?.code === "email_not_confirmed")
      throw new ApiError(403, "Confirm your email address before signing in.");
    if (error?.status === 429)
      throw new ApiError(
        429,
        "Too many sign-in attempts. Wait a moment and try again.",
      );
    if (!error?.status || error.status >= 500)
      throw new ApiError(
        503,
        "The sign-in service is unavailable. Please try again shortly.",
      );
    throw new ApiError(
      401,
      "The email or password is incorrect. If you usually sign in with Google, choose Continue with Google.",
    );
  }
  try {
    await verifySuperadmin(db);
  } catch (error) {
    await db.auth.signOut();
    throw error;
  }
  return json({ user: { id: data.user.id, email: data.user.email || "" } });
});
