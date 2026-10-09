// Shared server-only helpers for server functions and the settlement worker.

export async function adminDb() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // The generated database types can briefly lag behind applied migrations.
  return supabaseAdmin as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function getConfig<T = any>(key: string): Promise<T> {
  // eslint-disable-line @typescript-eslint/no-explicit-any
  const db = await adminDb();
  const { data, error } = await db.from("app_config").select("value").eq("key", key).maybeSingle();
  if (error) throw new Error(`Couldn't read config ${key}: ${error.message}`);
  if (!data) throw new Error(`Missing config: ${key}`);
  return data.value as T;
}

export async function getConfigOr<T>(key: string, fallback: T): Promise<T> {
  try {
    return await getConfig<T>(key);
  } catch {
    return fallback;
  }
}

export async function audit(actor: string | null, action: string, details: unknown) {
  const db = await adminDb();
  const { error } = await db.from("audit_log").insert({ actor, action, details });
  if (error) console.error("[audit] failed", action, error.message);
}

/** Server-side admin check (service role; never trusts the client). */
export async function assertAdmin(userId: string) {
  const db = await adminDb();
  const { data, error } = await db.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error) throw new Error(`Role check failed: ${error.message}`);
  if (!data) throw new Error("Forbidden");
}

/** Calls a Postgres function and surfaces the real database error. */
export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  // eslint-disable-line @typescript-eslint/no-explicit-any
  const db = await adminDb();
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export async function raiseAlert(
  kind: string,
  subject: string,
  severity: "info" | "warning" | "critical",
  message: string,
  details: unknown = {},
) {
  try {
    await rpc("raise_alert", {
      _kind: kind,
      _subject: subject,
      _severity: severity,
      _message: message,
      _details: details,
    });
  } catch (e) {
    console.error("[alert] failed to record", kind, subject, (e as Error).message);
  }
}

/** Throws unless the query succeeded; returns rows. */
export function must<T>(
  res: { data: T | null; error: { message: string } | null },
  what: string,
): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return (res.data ?? ([] as unknown)) as T;
}

/** Formula-safe CSV cell (prevents spreadsheet formula injection). */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  // Plain integers/decimals (e.g. negative ledger amounts) stay numeric; anything else that a
  // spreadsheet could treat as a formula is prefixed with a quote.
  if (!/^-?\d+(\.\d+)?$/.test(s) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]) {
  return [header.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n");
}
