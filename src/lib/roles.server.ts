// Who is the super admin. There is exactly one; promoted admins are ordinary admins.
//
// The super_admins table (drizzle 0009) is the record. On a database where that update hasn't arrived yet
// (the live site on Oct 11), the server used to treat EVERY admin as the super admin, so a promoted admin
// showed up as a second "Super admin" that couldn't be demoted or deleted. Now, without the table, the super
// admin is the account marked super_admin in its server-only app_metadata, and if none is marked yet, the
// admin who promoted the others (only the super admin can promote), else the earliest-created admin account;
// that account then gets marked so the choice never moves.
/* eslint-disable @typescript-eslint/no-explicit-any */

export type Role = "super" | "admin" | "user";

async function adminIds(db: any): Promise<string[]> {
  const { data } = await db.from("user_roles").select("user_id").eq("role", "admin");
  return [...new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id))];
}

/** The one super admin's user id (null if there are no admins at all). */
export async function superAdminId(db: any): Promise<string | null> {
  const { data: rows, error } = await db.from("super_admins").select("user_id").limit(1);
  if (!error && rows?.length) return rows[0].user_id as string;

  const ids = await adminIds(db);
  if (!ids.length) return null;
  const users = (
    await Promise.all(ids.map(async (id) => (await db.auth.admin.getUserById(id)).data?.user ?? null))
  ).filter(Boolean) as any[];
  const marked = users.find((u) => u.app_metadata?.super_admin === true);
  if (marked) return marked.id as string;
  // Only the super admin can promote: whoever promoted an admin first is the super admin.
  const { data: promo } = await db
    .from("audit_log")
    .select("actor")
    .eq("action", "role.promoted")
    .order("created_at", { ascending: true })
    .limit(1);
  const promoter = users.find((u) => u.id === (promo?.[0]?.actor as string | undefined));
  const first =
    promoter ?? [...users].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
  if (!first) return null;
  await db.auth.admin
    .updateUserById(first.id, { app_metadata: { ...(first.app_metadata ?? {}), super_admin: true } })
    .catch(() => undefined);
  if (!error) await db.from("super_admins").insert({ user_id: first.id }).then(() => undefined, () => undefined);
  return first.id as string;
}

export async function roleOf(db: any, userId: string): Promise<Role> {
  const { data: adm } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!adm) return "user";
  return (await superAdminId(db)) === userId ? "super" : "admin";
}
