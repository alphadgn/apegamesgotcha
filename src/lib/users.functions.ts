// Accounts and roles.
// - Every signed-in player: read and edit only their own profile (username + profile picture).
// - Super admin: list accounts, promote any account to admin, demote admins back to player, rename, delete.
//   Promoted admins can't do any of this, and nobody can change or delete the super admin here.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

export type Role = "super" | "admin" | "user";

async function roleOf(db: any, userId: string): Promise<Role> {
  const { data: sup, error } = await db
    .from("super_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  const { data: adm } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!adm) return "user";
  // Before drizzle 0009 (no super_admins table yet) every admin is the super admin.
  if (error) return "super";
  return sup ? "super" : "admin";
}

async function assertSuper(ctx: { userId: string }) {
  const db = await admin();
  if ((await roleOf(db, ctx.userId)) !== "super")
    throw new Error("Only the super admin can manage accounts.");
  return db;
}

async function audit(actor: string, action: string, details: Record<string, unknown>) {
  const db = await admin();
  await db.from("audit_log").insert({ actor, action, details });
}

/** Usernames: 3–24 letters, numbers, spaces, dots, dashes or underscores. */
export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(24, "Username can be at most 24 characters")
  .regex(/^[A-Za-z0-9 ._-]+$/, "Use letters, numbers, spaces, dots, dashes or underscores");

async function assertUsernameFree(db: any, name: string, exceptUserId: string) {
  const pattern = name.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data } = await db
    .from("profiles")
    .select("id")
    .ilike("display_name", pattern)
    .neq("id", exceptUserId)
    .limit(1);
  if (data?.length) throw new Error("That username is taken. Try another one.");
}

// ---------- The signed-in player's own account ----------

/** The signed-in player's role (for showing the right admin tabs; every action is still checked on the server). */
export const getMyRole = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => ({ role: await roleOf(await admin(), context.userId) }));

export const getMyProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = await admin();
    const { data, error } = await db
      .from("profiles")
      .select("display_name, avatar_url, created_at")
      .eq("id", context.userId)
      .maybeSingle();
    const row = error
      ? ((
          await db
            .from("profiles")
            .select("display_name, created_at")
            .eq("id", context.userId)
            .maybeSingle()
        ).data as any)
      : (data as any);
    const { data: u } = await db.auth.admin.getUserById(context.userId);
    return {
      displayName: (row?.display_name as string | null) ?? null,
      avatarPath: (row?.avatar_url as string | null) ?? null,
      email: (u?.user?.email as string | undefined) ?? null,
      memberSince: (row?.created_at as string | undefined) ?? u?.user?.created_at ?? null,
      role: await roleOf(db, context.userId),
    };
  });

export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ displayName: usernameSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const db = await admin();
    await assertUsernameFree(db, data.displayName, context.userId);
    const { error } = await db
      .from("profiles")
      .upsert({
        id: context.userId,
        display_name: data.displayName,
        updated_at: new Date().toISOString(),
      });
    if (error) throw new Error(`Couldn't save your username: ${error.message}`);
    await audit(context.userId, "profile.updated", { display_name: data.displayName });
    return { ok: true };
  });

/** Save (or clear) the profile picture the player just uploaded to their own folder in the avatars bucket. */
export const setMyAvatar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ path: z.string().max(300).nullable() }).parse(d))
  .handler(async ({ data, context }) => {
    if (data.path && !data.path.startsWith(`${context.userId}/`))
      throw new Error("That picture isn't yours.");
    const db = await admin();
    const { data: before } = await db
      .from("profiles")
      .select("avatar_url")
      .eq("id", context.userId)
      .maybeSingle();
    const { error } = await db
      .from("profiles")
      .upsert({ id: context.userId, avatar_url: data.path, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Couldn't save your picture: ${error.message}`);
    // Remove the old picture file (only ever the player's own).
    const old = before?.avatar_url as string | null | undefined;
    if (old && old !== data.path && old.startsWith(`${context.userId}/`))
      await db.storage.from("avatars").remove([old]);
    return { ok: true };
  });

// ---------- Super admin: accounts and admins ----------

export type AccountRow = {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarPath: string | null;
  role: Role;
  createdAt: string | null;
  lastSignInAt: string | null;
};

/** Accounts for the Admins tab: every admin first, then players matching the search (newest first). */
export const superListAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ query: z.string().trim().max(100).default("") }).parse(d))
  .handler(async ({ data, context }) => {
    const db = await assertSuper(context);
    const users: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const { data: res, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw new Error(error.message);
      users.push(...(res?.users ?? []));
      if ((res?.users ?? []).length < 1000) break;
    }
    const ids = users.map((u) => u.id);
    const [{ data: profiles }, { data: admins }, supers] = await Promise.all([
      db.from("profiles").select("id, display_name, avatar_url").in("id", ids),
      db.from("user_roles").select("user_id").eq("role", "admin"),
      db.from("super_admins").select("user_id"),
    ]);
    const prof = new Map(((profiles ?? []) as any[]).map((p) => [p.id, p]));
    const adminSet = new Set(((admins ?? []) as any[]).map((a) => a.user_id));
    const superSet = new Set(
      supers.error ? [...adminSet] : ((supers.data ?? []) as any[]).map((a) => a.user_id),
    );
    const q = data.query.toLowerCase();
    const rows: AccountRow[] = users.map((u) => ({
      id: u.id,
      email: u.email ?? null,
      displayName: prof.get(u.id)?.display_name ?? null,
      avatarPath: prof.get(u.id)?.avatar_url ?? null,
      role: superSet.has(u.id) ? "super" : adminSet.has(u.id) ? "admin" : "user",
      createdAt: u.created_at ?? null,
      lastSignInAt: u.last_sign_in_at ?? null,
    }));
    const order = { super: 0, admin: 1, user: 2 } as const;
    const matches = rows
      .filter(
        (r) =>
          r.role !== "user" ||
          !q ||
          `${r.email ?? ""} ${r.displayName ?? ""} ${r.id}`.toLowerCase().includes(q),
      )
      .sort(
        (a, b) =>
          order[a.role] - order[b.role] || String(b.createdAt).localeCompare(String(a.createdAt)),
      );
    return { rows: matches.slice(0, 150), total: rows.length };
  });

/** Promote an account to admin, or make an admin a regular player again. */
export const superSetRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ userId: z.string().uuid(), role: z.enum(["admin", "user"]) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const db = await assertSuper(context);
    if ((await roleOf(db, data.userId)) === "super")
      throw new Error("The super admin's role can't be changed here.");
    if (data.role === "admin") {
      const { error } = await db
        .from("user_roles")
        .upsert({ user_id: data.userId, role: "admin" }, { onConflict: "user_id,role" });
      if (error) throw new Error(error.message);
    } else {
      const { error } = await db
        .from("user_roles")
        .delete()
        .eq("user_id", data.userId)
        .eq("role", "admin");
      if (error) throw new Error(error.message);
    }
    await db
      .from("user_roles")
      .upsert({ user_id: data.userId, role: "user" }, { onConflict: "user_id,role" });
    await audit(context.userId, data.role === "admin" ? "role.promoted" : "role.demoted", {
      user_id: data.userId,
    });
    return { ok: true };
  });

/** Rename an account (its username shown on the leaderboard). */
export const superUpdateAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ userId: z.string().uuid(), displayName: usernameSchema }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const db = await assertSuper(context);
    await assertUsernameFree(db, data.displayName, data.userId);
    const { error } = await db
      .from("profiles")
      .upsert({
        id: data.userId,
        display_name: data.displayName,
        updated_at: new Date().toISOString(),
      });
    if (error) throw new Error(error.message);
    await audit(context.userId, "account.renamed", {
      user_id: data.userId,
      display_name: data.displayName,
    });
    return { ok: true };
  });

/**
 * Delete an account: sign-in, profile, roles, wallets (so they can be linked again), points and unused spins.
 * Spin and purchase history stays for the records. The super admin can't be deleted here.
 */
export const superDeleteAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const db = await assertSuper(context);
    if (data.userId === context.userId) throw new Error("You can't delete your own account.");
    if ((await roleOf(db, data.userId)) === "super")
      throw new Error("The super admin can't be deleted.");
    const { data: u } = await db.auth.admin.getUserById(data.userId);
    const { data: prof } = await db
      .from("profiles")
      .select("avatar_url")
      .eq("id", data.userId)
      .maybeSingle();
    // Each table on its own: one that doesn't exist (or is already clean) doesn't stop the rest.
    const cleanups: [string, (q: any) => any][] = [
      ["wallets", (q) => q.delete().eq("user_id", data.userId)],
      ["wallet_nonces", (q) => q.delete().eq("user_id", data.userId)],
      ["privy_accounts", (q) => q.delete().eq("user_id", data.userId)],
      ["points_ledger", (q) => q.delete().eq("user_id", data.userId)],
      ["spin_credits", (q) => q.delete().eq("user_id", data.userId).is("used_spin_id", null)],
      ["nft_holdings", (q) => q.update({ user_id: null }).eq("user_id", data.userId)],
      ["user_roles", (q) => q.delete().eq("user_id", data.userId)],
      ["profiles", (q) => q.delete().eq("id", data.userId)],
    ];
    const problems: string[] = [];
    for (const [table, op] of cleanups) {
      const { error } = await op(db.from(table));
      if (error && !/does not exist|column .* does not exist/i.test(error.message))
        problems.push(`${table}: ${error.message}`);
    }
    if (prof?.avatar_url)
      await db.storage
        .from("avatars")
        .remove([prof.avatar_url])
        .catch(() => undefined);
    const { error } = await db.auth.admin.deleteUser(data.userId);
    if (error) throw new Error(`Couldn't delete the sign-in: ${error.message}`);
    await audit(context.userId, "account.deleted", {
      user_id: data.userId,
      email: u?.user?.email ?? null,
      problems,
    });
    return { ok: true, problems };
  });
