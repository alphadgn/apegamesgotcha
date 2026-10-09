// Helpers for the real-Postgres tests: build databases from the repo's migrations and run queries
// as the same roles Supabase/PostgREST uses (anon, authenticated with JWT claims, service_role).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "supabase", "migrations");
const DRIZZLE_DIR = join(here, "..", "drizzle", "migrations");
const DRIZZLE_BEFORE = "20261009";

async function applyDrizzle(c) {
  let files = [];
  try {
    files = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return;
  }
  for (const f of files) {
    const sql = readFileSync(join(DRIZZLE_DIR, f), "utf8").split("--> statement-breakpoint").join("\n");
    try {
      await c.query(sql);
    } catch (e) {
      throw new Error(`Drizzle migration ${f} failed: ${e.message}`);
    }
  }
}
const BASELINE = join(here, "supabase_baseline.sql");

export const PG = {
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 54329),
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? undefined,
};

// bigint (int8) and numeric come back as strings — keep them that way (bigint-safe).
pg.types.setTypeParser(20, (v) => v);

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function adminQuery(sql) {
  const c = new pg.Client({ ...PG, database: "postgres" });
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}

export async function dropDatabase(name) {
  await adminQuery(`drop database if exists "${name}" with (force)`);
}

/** Creates a fresh database with the Supabase baseline and the migrations accepted by `filter`. */
export async function createDatabase(name, { filter = () => true, after } = {}) {
  await dropDatabase(name);
  await adminQuery(`create database "${name}"`);
  const c = new pg.Client({ ...PG, database: name });
  await c.connect();
  try {
    await c.query(readFileSync(BASELINE, "utf8"));
    let drizzleDone = false;
    for (const f of migrationFiles().filter(filter)) {
      // Tables Lovable creates through drizzle (e.g. contact_messages) already exist in production
      // before the season migrations; apply them at the same point here.
      if (!drizzleDone && f >= DRIZZLE_BEFORE) {
        await applyDrizzle(c);
        drizzleDone = true;
      }
      try {
        await c.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      } catch (e) {
        throw new Error(`Migration ${f} failed: ${e.message}`);
      }
    }
    if (after) await after(c);
  } finally {
    await c.end();
  }
}

export async function applyMigrations(name, filter) {
  const c = new pg.Client({ ...PG, database: name });
  await c.connect();
  try {
    if (migrationFiles().filter(filter).some((f) => f >= DRIZZLE_BEFORE)) await applyDrizzle(c);
    for (const f of migrationFiles().filter(filter)) {
      try {
        await c.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      } catch (e) {
        throw new Error(`Migration ${f} failed: ${e.message}`);
      }
    }
  } finally {
    await c.end();
  }
}

let templateReady = null;
/** A database cloned from a template that has every migration applied (fast per-test isolation). */
export async function freshDb(label = "t") {
  if (!templateReady) {
    templateReady = createDatabase("gotcha_template");
  }
  await templateReady;
  const name = `gotcha_${label}_${Math.random().toString(36).slice(2, 8)}`;
  await adminQuery(`create database "${name}" template gotcha_template`);
  const pool = new pg.Pool({ ...PG, database: name, max: 12 });
  // Idle connections are force-closed when the test database is dropped; that is expected.
  pool.on("error", () => {});
  return new Db(name, pool);
}

export class Db {
  constructor(name, pool) {
    this.name = name;
    this.pool = pool;
  }
  async close() {
    await this.pool.end();
    await dropDatabase(this.name);
  }
  /** Superuser (migration owner) query. */
  async q(sql, params) {
    return (await this.pool.query(sql, params)).rows;
  }
  async one(sql, params) {
    const rows = await this.q(sql, params);
    return rows[0];
  }
  /** Run `fn(client)` inside a transaction as the given PostgREST role. */
  async as(role, claims, fn) {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims ?? {})]);
      await c.query(`set local role ${role}`);
      const out = await fn({
        q: async (sql, params) => (await c.query(sql, params)).rows,
        one: async (sql, params) => (await c.query(sql, params)).rows[0],
      });
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  asUser(userId, fn) {
    return this.as("authenticated", { sub: userId, role: "authenticated" }, fn);
  }
  asAnon(fn) {
    return this.as("anon", { role: "anon" }, fn);
  }
  asService(fn) {
    return this.as("service_role", { role: "service_role" }, fn);
  }
  /** Calls a function as service_role (how the app server calls RPCs). */
  async rpc(fn, args = []) {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return this.asService((s) => s.q(`select * from public.${fn}(${ph})`, args));
  }
  async createUser(email = `u-${randomUUID().slice(0, 8)}@example.com`) {
    const row = await this.one(`insert into auth.users(email) values ($1) returning id`, [email]);
    return row.id;
  }
}

/** Expect a promise to reject with a message matching `re`. */
export async function rejects(promise, re) {
  try {
    await promise;
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`Expected error matching ${re}, got: ${e.message}`);
    return e;
  }
  throw new Error(`Expected rejection${re ? ` matching ${re}` : ""}, but it succeeded`);
}
