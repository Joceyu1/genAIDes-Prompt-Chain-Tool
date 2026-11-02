import { json, route, supabaseServer } from "@/lib/server";
export const POST = route(async () => {
  const db = await supabaseServer();
  await db.auth.signOut();
  return json({ ok: true });
});
