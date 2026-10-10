// Admin spin grants (paid-equivalent "real" spins and "demo" practice spins), on any database version.
//
// The full design lives in supabase/migrations/20261010010000_admin_spin_grants.sql (spin_grants table,
// spin_credits.kind, admin_grant_spins / use_demo_spins). Lovable doesn't run migrations that arrive from
// GitHub, so until that migration is applied this module keeps grants working on the older schema:
//   - paid-equivalent grants become ordinary spin credits (source 'grant', ref '<grant id>:<n>')
//   - demo grants and their use are recorded in audit_log (players can't read it; only this server does)
// When the migration runs it moves both into spin_grants / spin_credits, so nothing granted is lost.
// Server-only: import from server function handlers.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;
export type GrantKind = "real" | "demo";

export type SpinGrantRow = {
  id: string;
  created_at: string;
  kind: GrantKind;
  count: number;
  used: number;
  note: string;
  player: string;
  granted_by: string;
};

const DEMO_GRANTED = "admin.grant_demo_spins";
const DEMO_USED = "demo.spins_used";
const REAL_GRANTED = "admin.grant_spins";

let schemaCache: { full: boolean; at: number } | undefined;

/** True once the grant migration is applied (spin_grants exists and credits have a kind). */
export async function grantSchemaReady(db: Db): Promise<boolean> {
  if (schemaCache && Date.now() - schemaCache.at < 60_000) return schemaCache.full;
  const [t, c] = await Promise.all([
    // Plain GETs (not HEAD): a HEAD error has no body, so it can't say *what* is missing.
    db.from("spin_grants").select("id").limit(1),
    db.from("spin_credits").select("kind, used_at").limit(1),
  ]);
  const err = t.error ?? c.error;
  if (err && !isMissingSchema(err)) throw new Error(`Couldn't read spin grants: ${err.message}`);
  const full = !err;
  schemaCache = { full, at: Date.now() };
  return full;
}

/** PostgREST / Postgres errors meaning "this table, column or function isn't there yet". */
export function isMissingSchema(e: { code?: string; message?: string } | null | undefined) {
  if (!e) return false;
  return (
    ["PGRST202", "PGRST204", "PGRST205", "42P01", "42703", "42883"].includes(e.code ?? "") ||
    /could not find the (table|function|column)|does not exist|schema cache/i.test(e.message ?? "")
  );
}

export async function grantSpins(
  db: Db,
  g: { userId: string; count: number; kind: GrantKind; note: string; actor: string },
) {
  if (await grantSchemaReady(db)) {
    const { error } = await db.rpc("admin_grant_spins", {
      _user_id: g.userId,
      _count: g.count,
      _kind: g.kind,
      _note: g.note,
      _actor: g.actor,
    });
    if (!error) return;
    if (!isMissingSchema(error)) throw new Error(`Couldn't grant spins: ${error.message}`);
    schemaCache = undefined; // schema changed under us; fall through to the compatible path
  }
  const grantId = crypto.randomUUID();
  const details = { grant_id: grantId, user_id: g.userId, kind: g.kind, count: g.count, note: g.note };
  if (g.kind === "real") {
    const rows = Array.from({ length: g.count }, (_, i) => ({
      user_id: g.userId,
      source: "grant",
      ref: `${grantId}:${i + 1}`,
      created_by: g.actor,
    }));
    const { error } = await db.from("spin_credits").insert(rows);
    if (error) throw new Error(`Couldn't grant spins: ${error.message}`);
    await audit(db, g.actor, REAL_GRANTED, details);
  } else {
    // Must succeed: this row *is* the demo grant until the migration moves it into spin_grants.
    const { error } = await db.from("audit_log").insert({ actor: g.actor, action: DEMO_GRANTED, details });
    if (error) throw new Error(`Couldn't grant demo spins: ${error.message}`);
  }
}

/** Spins a player can use right now: real (on-chain) and demo (practice). */
export async function spinBalance(db: Db, userId: string): Promise<{ real: number; demo: number }> {
  if (await grantSchemaReady(db)) {
    const [r, d] = await Promise.all([
      db.from("spin_credits").select("id", { head: true, count: "exact" }).eq("user_id", userId).eq("kind", "real").is("used_spin_id", null),
      db.from("spin_credits").select("id", { head: true, count: "exact" }).eq("user_id", userId).eq("kind", "demo").is("used_spin_id", null).is("used_at", null),
    ]);
    const err = r.error ?? d.error;
    if (!err) return { real: r.count ?? 0, demo: d.count ?? 0 };
    if (!isMissingSchema(err)) throw new Error(err.message);
    schemaCache = undefined;
  }
  const { count, error } = await db
    .from("spin_credits")
    .select("id", { head: true, count: "exact" })
    .eq("user_id", userId)
    .is("used_spin_id", null);
  if (error) throw new Error(error.message);
  return { real: count ?? 0, demo: await legacyDemoBalance(db, userId) };
}

/** Use up to `count` granted demo spins. Returns how many were available. */
export async function useDemoSpins(db: Db, userId: string, count: number): Promise<number> {
  if (await grantSchemaReady(db)) {
    const { data, error } = await db.rpc("use_demo_spins", { _user_id: userId, _count: count });
    if (!error) return Number(data ?? 0);
    if (!isMissingSchema(error)) throw new Error(error.message);
    schemaCache = undefined;
  }
  const n = Math.min(count, await legacyDemoBalance(db, userId));
  if (n > 0) await audit(db, userId, DEMO_USED, { user_id: userId, count: n });
  return n;
}

/** Every grant with how many of its spins have been used, newest first. */
export async function listGrants(db: Db): Promise<{ rows: SpinGrantRow[]; pendingMigration: boolean }> {
  const emails = await emailMap(db);
  const name = (id: string | null | undefined) => (id ? (emails.get(id) ?? id) : "—");

  if (await grantSchemaReady(db)) {
    const { data: grants, error } = await db
      .from("spin_grants")
      .select("id, created_at, kind, count, note, user_id, created_by")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    const rows = (grants ?? []) as { id: string; created_at: string; kind: GrantKind; count: number; note: string; user_id: string; created_by: string | null }[];
    const used = new Map<string, number>();
    const ids = rows.map((g) => g.id);
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error: e2 } = await db.from("spin_credits").select("grant_id, used_spin_id, used_at").in("grant_id", ids.slice(i, i + 100));
      if (e2) throw new Error(e2.message);
      for (const c of (data ?? []) as { grant_id: string; used_spin_id: string | null; used_at: string | null }[])
        if (c.used_spin_id || c.used_at) used.set(c.grant_id, (used.get(c.grant_id) ?? 0) + 1);
    }
    return {
      pendingMigration: false,
      rows: rows.map((g) => ({
        id: g.id,
        created_at: g.created_at,
        kind: g.kind,
        count: g.count,
        used: used.get(g.id) ?? 0,
        note: g.note,
        player: name(g.user_id),
        granted_by: name(g.created_by),
      })),
    };
  }

  // Older schema: paid-equivalent grants from spin_credits, notes and demo grants from audit_log.
  const [{ data: credits, error: e1 }, { data: logs, error: e2 }] = await Promise.all([
    db.from("spin_credits").select("user_id, ref, created_by, created_at, used_spin_id").eq("source", "grant").order("created_at", { ascending: false }).limit(5000),
    db.from("audit_log").select("created_at, action, actor, details").in("action", [REAL_GRANTED, DEMO_GRANTED, DEMO_USED, "admin.grant"]).order("created_at", { ascending: true }).limit(5000),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  const notes = new Map<string, string>();
  for (const l of (logs ?? []) as { action: string; details: any }[])
    if (l.action === REAL_GRANTED && l.details?.grant_id) notes.set(l.details.grant_id, String(l.details.note ?? ""));

  const groups = new Map<string, SpinGrantRow & { user_id: string }>();
  for (const c of (credits ?? []) as { user_id: string; ref: string | null; created_by: string | null; created_at: string; used_spin_id: string | null }[]) {
    const gid = c.ref?.includes(":") ? c.ref.split(":")[0]! : `${c.user_id}|${c.created_by}|${c.created_at.slice(0, 19)}`;
    const g =
      groups.get(gid) ??
      ({
        id: gid,
        created_at: c.created_at,
        kind: "real",
        count: 0,
        used: 0,
        note: notes.get(gid) ?? "Granted before grant tracking",
        player: name(c.user_id),
        granted_by: name(c.created_by),
        user_id: c.user_id,
      } as SpinGrantRow & { user_id: string });
    g.count += 1;
    if (c.used_spin_id) g.used += 1;
    groups.set(gid, g);
  }

  // Demo grants: spread each player's used demo spins over their grants, oldest first.
  const demo: (SpinGrantRow & { user_id: string })[] = [];
  const usedBy = new Map<string, number>();
  for (const l of (logs ?? []) as { created_at: string; action: string; actor: string | null; details: any }[]) {
    if (l.action === DEMO_USED) usedBy.set(l.details?.user_id, (usedBy.get(l.details?.user_id) ?? 0) + Number(l.details?.count ?? 0));
    if (l.action === DEMO_GRANTED)
      demo.push({
        id: String(l.details?.grant_id),
        created_at: l.created_at,
        kind: "demo",
        count: Number(l.details?.count ?? 0),
        used: 0,
        note: String(l.details?.note ?? ""),
        player: name(l.details?.user_id),
        granted_by: name(l.actor),
        user_id: l.details?.user_id,
      });
  }
  for (const d of demo) {
    const left = usedBy.get(d.user_id) ?? 0;
    d.used = Math.min(d.count, left);
    usedBy.set(d.user_id, left - d.used);
  }
  const rows = [...groups.values(), ...demo]
    .map(({ user_id: _u, ...r }) => r)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { rows, pendingMigration: true };
}

async function legacyDemoBalance(db: Db, userId: string) {
  const { data, error } = await db
    .from("audit_log")
    .select("action, details")
    .in("action", [DEMO_GRANTED, DEMO_USED])
    .eq("details->>user_id", userId)
    .limit(5000);
  if (error) throw new Error(error.message);
  let n = 0;
  for (const l of (data ?? []) as { action: string; details: any }[])
    n += (l.action === DEMO_GRANTED ? 1 : -1) * Number(l.details?.count ?? 0);
  return Math.max(0, n);
}

async function audit(db: Db, actor: string, action: string, details: unknown) {
  await db.from("audit_log").insert({ actor, action, details });
}

async function emailMap(db: Db) {
  const emails = new Map<string, string>();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Couldn't list players: ${error.message}`);
    const users = (data?.users ?? []) as { id: string; email?: string }[];
    for (const u of users) emails.set(u.id, u.email ?? u.id);
    if (users.length < 1000) break;
  }
  return emails;
}
