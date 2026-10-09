// Real-PostgreSQL harness for migration, RPC and RLS tests.
// Needs a PostgreSQL 15+ server: set TEST_DATABASE_URL (default postgres://postgres@127.0.0.1:54329/postgres).
// Each test file gets its own throwaway database with the Supabase shim + every migration applied.
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const ADMIN_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://postgres@127.0.0.1:54329/postgres";
const ROOT = join(import.meta.dirname, "..", "..");
export const MIGRATIONS_DIR = join(ROOT, "migrations");
const SHIM = join(import.meta.dirname, "..", "support", "supabase-shim.sql");

export type Sql = postgres.Sql<Record<string, never>>;

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** First migration added by the season leaderboard work (everything before it is "existing"). */
export const FIRST_NEW_MIGRATION = "20261010090000_identity_security_hardening.sql";

function dbUrl(name: string) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function applyFile(sql: Sql, file: string) {
  const text = readFileSync(file, "utf8");
  await sql.begin(async (tx) => {
    await tx.unsafe(text);
  });
}

/** Create a fresh database. `upTo` = apply migrations strictly before this file name (for upgrade tests). */
export async function createDb(opts: { upTo?: string; label?: string } = {}) {
  const name = `t_${(opts.label ?? "db")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 20)}_${randomUUID().slice(0, 8)}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const sql = postgres(dbUrl(name), { max: 20, onnotice: () => {} }) as unknown as Sql;
  await applyFile(sql, SHIM);
  for (const f of migrationFiles()) {
    if (opts.upTo && f >= opts.upTo) break;
    await applyFile(sql, join(MIGRATIONS_DIR, f));
  }
  return {
    name,
    sql,
    async applyRemaining(from: string) {
      for (const f of migrationFiles())
        if (f >= from) await applyFile(sql, join(MIGRATIONS_DIR, f));
    },
    async drop() {
      await sql.end({ timeout: 2 });
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

type Role = "service_role" | "authenticated" | "anon";

const sigCache = new WeakMap<object, Map<string, { name: string; type: string }[]>>();

async function signature(sql: Sql, fn: string, argNames: string[]) {
  let cache = sigCache.get(sql);
  if (!cache) sigCache.set(sql, (cache = new Map()));
  const key = `${fn}(${argNames.join(",")})`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rows = await sql<{ args: string[] | null; types: string[] }[]>`
    select p.proargnames as args, array(select format_type(t, null) from unnest(p.proargtypes) t) as types
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = ${fn}`;
  for (const r of rows) {
    const names = (r.args ?? []).slice(0, r.types.length);
    if (argNames.every((a) => names.includes(a))) {
      const sig = argNames.map((a) => ({ name: a, type: r.types[names.indexOf(a)]! }));
      cache.set(key, sig);
      return sig;
    }
  }
  throw new Error(`No public.${fn} accepting ${argNames.join(", ")}`);
}

/** Call public.<fn>(named args) as a given API role (and JWT subject), like PostgREST would. */
export async function rpc<T = Record<string, unknown>>(
  sql: Sql,
  fn: string,
  args: Record<string, unknown> = {},
  as: { role?: Role; uid?: string } = {},
): Promise<T[]> {
  const names = Object.keys(args);
  const sig = await signature(sql, fn, names);
  const params = sig.map((s) => {
    const v = args[s.name];
    if (v === null || v === undefined) return null;
    if (s.type === "jsonb" || s.type === "json") return v; // postgres.js serialises json params itself
    if (Array.isArray(v))
      return v.map((x) => (x === null ? null : typeof x === "bigint" ? x.toString() : x));
    if (typeof v === "bigint") return v.toString();
    return v;
  });
  const call = `select * from public.${fn}(${sig.map((s, i) => `${s.name} => $${i + 1}::${s.type}`).join(", ")})`;
  return sql.begin(async (tx) => {
    await setRole(tx as unknown as Sql, as.role ?? "service_role", as.uid);
    return (await tx.unsafe(call, params as never[])) as unknown as T[];
  }) as Promise<T[]>;
}

export async function setRole(tx: Sql, role: Role, uid?: string) {
  await tx.unsafe(`set local role ${role}`);
  await tx.unsafe(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify(uid ? { sub: uid, role } : { role }),
  ]);
}

/** Run queries as an API role inside one transaction. */
export async function asRole<T>(
  sql: Sql,
  role: Role,
  uid: string | undefined,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await setRole(tx as unknown as Sql, role, uid);
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

export async function createUser(
  sql: Sql,
  email = `${randomUUID().slice(0, 8)}@example.test`,
  meta: Record<string, unknown> = {},
) {
  const [u] = await sql<
    { id: string }[]
  >`insert into auth.users (email, raw_user_meta_data) values (${email}, ${sql.json(meta as never)}) returning id`;
  return u!.id;
}

export async function makeAdmin(sql: Sql, uid: string) {
  await sql`insert into public.user_roles (user_id, role, note) values (${uid}, 'admin', 'test admin') on conflict do nothing`;
}

export function addr(n: number) {
  return `0x${n.toString(16).padStart(40, "0")}`;
}
export function hash32(n: number | string) {
  const h = typeof n === "number" ? n.toString(16) : Buffer.from(n).toString("hex");
  return `0x${h.padStart(64, "0").slice(-64)}`;
}

/** Expect a promise to reject with a message matching `re`. */
export async function rejects(p: Promise<unknown>, re: RegExp) {
  try {
    await p;
  } catch (e) {
    const m = (e as Error).message;
    if (!re.test(m)) throw new Error(`Expected error ${re}, got: ${m}`);
    return m;
  }
  throw new Error(`Expected rejection matching ${re}`);
}
