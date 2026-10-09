// Shared server-only plumbing for server functions and the settlement worker.
import { supabaseDb, type Db } from "./db-rpc";
import type { DrawDeps } from "./draws.server";
import type { VrfConfig } from "./vrf.server";

export async function adminClient() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // The generated database types can briefly lag behind applied migrations.
  return supabaseAdmin as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function serviceDb(): Promise<Db> {
  return supabaseDb(await adminClient());
}

export async function readConfig<T = Record<string, unknown>>(key: string): Promise<T> {
  const db = await adminClient();
  const { data, error } = await db.from("app_config").select("value").eq("key", key).maybeSingle();
  if (error) throw new Error(`Couldn't read configuration (${key}): ${error.message}`);
  if (!data) throw new Error(`Missing configuration: ${key}`);
  return data.value as T;
}

export async function audit(actor: string | null, action: string, details: unknown) {
  const db = await adminClient();
  await db.from("audit_log").insert({ actor, action, details });
}

/** Server-side admin check against user_roles (never trusts the browser). */
export async function assertAdmin(userId: string) {
  const db = await adminClient();
  const { data, error } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(`Couldn't check permissions: ${error.message}`);
  if (!data) throw new Error("Forbidden");
}

export async function drawDeps(cfg: VrfConfig): Promise<DrawDeps> {
  const vrf = await import("./vrf.server");
  return {
    db: await serviceDb(),
    chain: (chainId) => {
      try {
        return vrf.vrfPublic(cfg, chainId);
      } catch {
        return null;
      }
    },
    operator: () => vrf.operatorAccount(),
    minConfirmations: Math.max(1, Number(cfg.min_confirmations ?? 3)),
  };
}

/** Formula-safe CSV cell: neutralises =, +, -, @, tab and CR prefixes (spreadsheet injection). */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
