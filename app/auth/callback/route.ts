import { NextResponse } from "next/server";
import {
  ApiError,
  requestOrigin,
  supabaseServer,
  verifySuperadmin,
} from "@/lib/server";

// PKCE binds the code to the verifier cookie created by /api/auth/google.
// Never accept a user-supplied return URL or token from the callback fragment.
export async function GET(request: Request) {
  const incoming = new URL(request.url);
  const target = new URL("/", requestOrigin(request));
  const failure = (code: string) => {
    target.searchParams.set("auth_error", code);
    const response = NextResponse.redirect(target, 303);
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
  const code = incoming.searchParams.get("code");
  if (incoming.searchParams.has("error") || !code)
    return failure("oauth_cancelled");
  try {
    const db = await supabaseServer();
    const { data, error } = await db.auth.exchangeCodeForSession(code);
    if (error || !data.user) {
      await db.auth.signOut();
      return failure("oauth_session");
    }
    try {
      await verifySuperadmin(db, data.user.id);
    } catch (error) {
      await db.auth.signOut();
      return failure(
        error instanceof ApiError && error.status === 403
          ? "superadmin_required"
          : "profile_unavailable",
      );
    }
    const response = NextResponse.redirect(target, 303);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return failure("oauth_unavailable");
  }
}
