import { ApiError, json, readBody, route, supabaseServer } from "@/lib/server";
import { loginSchema } from "@/lib/validation";
export const POST = route(async (request) => {
  const body = await readBody(request, loginSchema);
  const db = await supabaseServer();
  const { data, error } = await db.auth.signInWithPassword(body);
  if (error || !data.user)
    throw new ApiError(401, "The email or password is incorrect.");
  const { data: profile, error: profileError } = await db
    .from("profiles")
    .select("is_superadmin")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError || profile?.is_superadmin !== true) {
    await db.auth.signOut();
    throw new ApiError(
      profileError ? 503 : 403,
      profileError
        ? "Your administrator profile could not be verified."
        : "This workspace is available to superadmins only.",
    );
  }
  return json({ user: { id: data.user.id, email: data.user.email || "" } });
});
