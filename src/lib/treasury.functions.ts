// Gotcha Treasury (super admin): GotchaFeeSplitter deployments. Phase 1 = deploy + record.
// The browser compiles and deploys the contract from the admin's wallet; `adminRecordSplitter` then checks the
// deployment on ApeChain (or Curtis) before saving it: the transaction succeeded, it created a contract, its
// creation code is exactly the reviewed source (SHA-256 of the bytecode without the constructor arguments), and
// owner / keeper / recipients are read back from the contract itself (never trusted from the page).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}
async function assertSuper(ctx: { supabase: any; userId: string }) {
  const { data } = await ctx.supabase.rpc("has_role", { _user_id: ctx.userId, _role: "admin" });
  if (!data) throw new Error("Forbidden");
  const { superAdminId } = await import("./roles.server");
  if ((await superAdminId(await admin())) !== ctx.userId) throw new Error("Only the super admin can use the treasury.");
}

const chainIdSchema = z.union([z.literal(33139), z.literal(33111)]);
/** Constructor arguments: owner, keeper, address[8] — ten 32-byte words. */
const ARGS_HEX_LENGTH = 10 * 64;

async function sha256Hex(text: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type SplitterRow = {
  id: string;
  chain_id: number;
  address: string;
  tx_hash: string;
  owner: string;
  keeper: string;
  recipients: string[];
  constructor_args: string;
  block_number: number | null;
  is_active: boolean;
  created_at: string;
};

export const adminListSplitters = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuper(context);
    const { data, error } = await (await admin()).from("treasury_splitters").select("*").order("created_at", { ascending: false });
    if (error) return { ready: false as const, rows: [] as SplitterRow[] };
    return { ready: true as const, rows: (data ?? []) as SplitterRow[] };
  });

/**
 * Records a deployment after checking it on-chain. `state: "pending"` = not mined yet (call again shortly).
 */
export const adminRecordSplitter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ chainId: chainIdSchema, txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertSuper(context);
    const { createPublicClient, getAddress } = await import("viem");
    const { chainDef, resilientTransport, chainErrorMessage } = await import("./rpc.server");
    const { SPLITTER_ABI, EXPECTED_BYTECODE_SHA256, SPLITTER_CHAINS } = await import("@/contracts/splitter");
    const meta = SPLITTER_CHAINS[data.chainId];
    const pub = createPublicClient({ chain: chainDef(data.chainId, meta.name, meta.rpc), transport: resilientTransport(data.chainId, meta.rpc) });
    const hash = data.txHash.toLowerCase() as `0x${string}`;
    let receipt, tx;
    try {
      [receipt, tx] = await Promise.all([pub.getTransactionReceipt({ hash }), pub.getTransaction({ hash })]);
    } catch (e) {
      const m = (e as Error).message ?? "";
      if (/not be found|not found|TransactionReceiptNotFound/i.test(m)) return { state: "pending" as const };
      throw new Error(chainErrorMessage(e, "read the deployment"));
    }
    if (receipt.status !== "success") throw new Error("The deployment transaction failed on-chain.");
    if (!receipt.contractAddress) throw new Error("That transaction didn't create a contract.");
    const input = tx.input.slice(2).toLowerCase();
    if (input.length <= ARGS_HEX_LENGTH) throw new Error("That transaction isn't a GotchaFeeSplitter deployment.");
    const creation = input.slice(0, input.length - ARGS_HEX_LENGTH);
    if ((await sha256Hex(creation)) !== EXPECTED_BYTECODE_SHA256)
      throw new Error("That contract wasn't built from the reviewed GotchaFeeSplitter source with the required compiler settings.");
    const address = getAddress(receipt.contractAddress);
    const read = (functionName: string) => pub.readContract({ address, abi: SPLITTER_ABI, functionName }) as Promise<unknown>;
    const [owner, keeper, buckets] = (await Promise.all([read("owner"), read("keeper"), read("getBuckets")])) as [string, string, { recipient: string }[]];
    const row = {
      chain_id: data.chainId,
      address: address.toLowerCase(),
      tx_hash: hash,
      owner: owner.toLowerCase(),
      keeper: keeper.toLowerCase(),
      recipients: buckets.map((b) => b.recipient.toLowerCase()),
      constructor_args: `0x${input.slice(input.length - ARGS_HEX_LENGTH)}`,
      block_number: Number(receipt.blockNumber),
      deployed_by: context.userId,
    };
    const db = await admin();
    const { error } = await db.from("treasury_splitters").upsert(row, { onConflict: "chain_id,address" });
    if (error) throw new Error(/treasury_splitters/.test(error.message) ? "The treasury turns on after the database update (0022)." : error.message);
    await db.from("audit_log").insert({ actor: context.userId, action: "treasury.splitter_deployed", details: { chain_id: data.chainId, address: row.address, tx: hash } });
    return { state: "saved" as const, address: row.address };
  });

/** Make a recorded splitter the active one on its chain (the one the dashboard and keeper will use). */
export const adminSetActiveSplitter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertSuper(context);
    const db = await admin();
    const { data: row } = await db.from("treasury_splitters").select("id, chain_id, address").eq("id", data.id).maybeSingle();
    if (!row) throw new Error("Deployment not found.");
    await db.from("treasury_splitters").update({ is_active: false }).eq("chain_id", row.chain_id).neq("id", row.id);
    const { error } = await db.from("treasury_splitters").update({ is_active: true }).eq("id", row.id);
    if (error) throw new Error(error.message);
    await db.from("audit_log").insert({ actor: context.userId, action: "treasury.splitter_active", details: { chain_id: row.chain_id, address: row.address } });
    return { ok: true };
  });
