// A tiny database-call interface shared by server modules and their tests.
// Production wraps the Supabase service-role client; tests wrap a real PostgreSQL connection.
// Every call returns rows (functions returning one composite row come back as a one-element array).

export type DbRpc = <T = Record<string, unknown>>(
  fn: string,
  args?: Record<string, unknown>,
) => Promise<T[]>;
export type DbSelect = <T = Record<string, unknown>>(
  table: string,
  filter: Record<string, unknown>,
  columns?: string,
) => Promise<T[]>;

export type Db = { rpc: DbRpc; select: DbSelect };

/** Postgres error text without the noise, so real database errors reach the caller. */
export class DbError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

type SupabaseLike = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  from: (t: string) => {
    select: (c: string) => {
      match: (
        f: Record<string, unknown>,
      ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
    };
  };
};

export function supabaseDb(client: unknown): Db {
  const c = client as SupabaseLike;
  return {
    async rpc<T>(fn: string, args: Record<string, unknown> = {}) {
      const { data, error } = await c.rpc(fn, args);
      if (error) throw new DbError(error.message, error.code);
      if (data == null) return [] as T[];
      return (Array.isArray(data) ? data : [data]) as T[];
    },
    async select<T>(table: string, filter: Record<string, unknown>, columns = "*") {
      const { data, error } = await c.from(table).select(columns).match(filter);
      if (error) throw new DbError(error.message, error.code);
      return (data ?? []) as T[];
    },
  };
}

/** JSON-serialisable value (what server functions may return to the browser). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
