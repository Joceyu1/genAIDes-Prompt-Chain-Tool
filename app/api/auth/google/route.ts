import { ApiError, json, route, supabaseServer } from "@/lib/server";

export const POST = route(async (request) => {
  const db = await supabaseServer();
  const { data, error } = await db.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: new URL("/auth/callback", request.url).toString(),
      skipBrowserRedirect: true,
      queryParams: { prompt: "select_account" },
    },
  });
  if (error || !data.url)
    throw new ApiError(
      503,
      "Google sign-in could not be started. Please try again.",
    );
  return json({ url: data.url });
});
