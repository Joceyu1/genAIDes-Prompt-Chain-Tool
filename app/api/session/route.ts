import { json, requireAdmin, route } from "@/lib/server";
export const dynamic = "force-dynamic";
export const GET = route(async () => {
  const { user } = await requireAdmin();
  return json({ user: { id: user.id, email: user.email || "" } });
});
