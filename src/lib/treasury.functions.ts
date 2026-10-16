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
  if ((await superAdminId(await admin())) !== ctx.userId)
    throw new Error("Only the super admin can use the treasury.");
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
    const { data, error } = await (
      await admin()
    )
      .from("treasury_splitters")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) return { ready: false as const, rows: [] as SplitterRow[] };
    return { ready: true as const, rows: (data ?? []) as SplitterRow[] };
  });

/**
 * Records a deployment after checking it on-chain. `state: "pending"` = not mined yet (call again shortly).
 */
export const adminRecordSplitter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ chainId: chainIdSchema, txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertSuper(context);
    const { createPublicClient, getAddress } = await import("viem");
    const { chainDef, resilientTransport, chainErrorMessage } = await import("./rpc.server");
    const { SPLITTER_ABI, EXPECTED_BYTECODE_SHA256, SPLITTER_CHAINS } =
      await import("@/contracts/splitter");
    const meta = SPLITTER_CHAINS[data.chainId];
    const pub = createPublicClient({
      chain: chainDef(data.chainId, meta.name, meta.rpc),
      transport: resilientTransport(data.chainId, meta.rpc),
    });
    const hash = data.txHash.toLowerCase() as `0x${string}`;
    let receipt, tx;
    try {
      [receipt, tx] = await Promise.all([
        pub.getTransactionReceipt({ hash }),
        pub.getTransaction({ hash }),
      ]);
    } catch (e) {
      const m = (e as Error).message ?? "";
      if (/not be found|not found|TransactionReceiptNotFound/i.test(m))
        return { state: "pending" as const };
      throw new Error(chainErrorMessage(e, "read the deployment"));
    }
    if (receipt.status !== "success")
      throw new Error("The deployment transaction failed on-chain.");
    if (!receipt.contractAddress) throw new Error("That transaction didn't create a contract.");
    const input = tx.input.slice(2).toLowerCase();
    if (input.length <= ARGS_HEX_LENGTH)
      throw new Error("That transaction isn't a GotchaFeeSplitter deployment.");
    const creation = input.slice(0, input.length - ARGS_HEX_LENGTH);
    if ((await sha256Hex(creation)) !== EXPECTED_BYTECODE_SHA256)
      throw new Error(
        "That contract wasn't built from the reviewed GotchaFeeSplitter source with the required compiler settings.",
      );
    const address = getAddress(receipt.contractAddress);
    const read = (functionName: string) =>
      pub.readContract({ address, abi: SPLITTER_ABI, functionName }) as Promise<unknown>;
    const [owner, keeper, buckets] = (await Promise.all([
      read("owner"),
      read("keeper"),
      read("getBuckets"),
    ])) as [string, string, { recipient: string }[]];
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
    const { error } = await db
      .from("treasury_splitters")
      .upsert(row, { onConflict: "chain_id,address" });
    if (error)
      throw new Error(
        /treasury_splitters/.test(error.message)
          ? "The treasury turns on after the database update (0022)."
          : error.message,
      );
    await db.from("audit_log").insert({
      actor: context.userId,
      action: "treasury.splitter_deployed",
      details: { chain_id: data.chainId, address: row.address, tx: hash },
    });
    return { state: "saved" as const, address: row.address };
  });

/** Make a recorded splitter the active one on its chain (the one the dashboard and keeper will use). */
export const adminSetActiveSplitter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertSuper(context);
    const db = await admin();
    const { data: row } = await db
      .from("treasury_splitters")
      .select("id, chain_id, address")
      .eq("id", data.id)
      .maybeSingle();
    if (!row) throw new Error("Deployment not found.");
    await db
      .from("treasury_splitters")
      .update({ is_active: false })
      .eq("chain_id", row.chain_id)
      .neq("id", row.id);
    const { error } = await db
      .from("treasury_splitters")
      .update({ is_active: true })
      .eq("id", row.id);
    if (error) throw new Error(error.message);
    await db.from("audit_log").insert({
      actor: context.userId,
      action: "treasury.splitter_active",
      details: { chain_id: row.chain_id, address: row.address },
    });
    return { ok: true };
  });

// ====================================================================================================
// Phase 2 (dashboard) and phase 3 (keeper bot) — super admin only.
// ====================================================================================================

const bucketSettings = z.object({
  enabled: z.boolean(),
  max_spend_eth: z.string().regex(/^\d{1,6}(\.\d{1,18})?$/, "Max spend in ETH, e.g. 1.5"),
});
const addrOrEmpty = z.union([
  z.literal(""),
  z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Enter a 0x… address"),
]);
const settingsSchema = z.object({
  splitter_chain_id: chainIdSchema,
  dry_run: z.boolean(),
  kill_switch: z.boolean(),
  buffer_pct: z.number().min(0).max(50),
  slippage_pct: z.number().min(0.1).max(30),
  target_move_pct: z.number().min(0).max(50),
  ape_gas_reserve: z.string().regex(/^\d{1,6}(\.\d{1,18})?$/),
  gas_allowance_eth: z.object({
    ethereum: z.string().regex(/^\d{1,3}(\.\d{1,18})?$/),
    robinhood: z.string().regex(/^\d{1,3}(\.\d{1,18})?$/),
  }),
  buckets: z.record(z.string(), bucketSettings),
  prize_wallet_ethereum: addrOrEmpty,
  prize_wallet_robinhood: addrOrEmpty,
  robinhood_chain_id: z.number().int().positive(),
  robinhood_rpc_url: z.union([z.literal(""), z.string().url().startsWith("https://")]),
  robinhood_opensea_chain: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{2,40}$/),
  stonk_marketplace: z.literal("opensea"),
  stonk_nft_contract: addrOrEmpty,
  stonk_nft_slug: z.string().trim().max(100),
  stonk_token: addrOrEmpty,
  bayc_slug: z.string().trim().min(2).max(100),
  mayc_slug: z.string().trim().min(2).max(100),
  eth_rpc_url: z.union([z.literal(""), z.string().url().startsWith("https://")]),
  telegram_chat_id: z.string().trim().max(40),
  fees_to_splitter: z.boolean(),
});

const hasEnv = (k: string) => !!process.env[k]?.trim();

/** Everything the Treasury dashboard shows. */
export const adminTreasuryOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuper(context);
    const db = await admin();
    const k = await import("./treasury-keeper.server");
    const s = await k.loadSettings();
    const sp = await k.activeSplitter(s.splitter_chain_id).catch(() => null);
    const m = await import("./treasury-market.server");
    const acct = m.keeperAccount();
    let chain: null | {
      buckets: {
        name: string;
        recipient: string;
        bps: number;
        mode: number;
        balance: string;
        target: string;
        ready: boolean;
      }[];
      totalReceived: string;
      totalTracked: string;
      balance: string;
      owner: string;
      keeper: string;
    } = null;
    let chainError: string | null = null;
    if (sp) {
      try {
        const r = await m.readSplitter(s.splitter_chain_id, sp.address);
        chain = {
          buckets: r.buckets.map((b) => ({
            name: b.name,
            recipient: b.recipient.toLowerCase(),
            bps: b.bps,
            mode: b.mode,
            balance: b.balance.toString(),
            target: b.target.toString(),
            ready: b.ready,
          })),
          totalReceived: r.totalReceived.toString(),
          totalTracked: r.totalTracked.toString(),
          balance: r.balance.toString(),
          owner: r.owner,
          keeper: r.keeper,
        };
      } catch (e) {
        const { chainErrorMessage } = await import("./rpc.server");
        chainError = chainErrorMessage(e, "read the splitter");
      }
    }
    const balances: { ape: string | null; ethereum: string | null; robinhood: string | null } = {
      ape: null,
      ethereum: null,
      robinhood: null,
    };
    if (acct) {
      const a = acct.address;
      const get = async (c: ReturnType<typeof m.apeChain>) =>
        (await m.reader(c).getBalance({ address: a })).toString();
      const [ape, ethB, rh] = await Promise.all([
        get(m.apeChain(s.splitter_chain_id)).catch(() => null),
        get(m.ethChain(s)).catch(() => null),
        s.robinhood_rpc_url || hasEnv("ROBINHOOD_RPC_URL")
          ? get(m.rhChain(s)).catch(() => null)
          : Promise.resolve(null),
      ]);
      Object.assign(balances, { ape, ethereum: ethB, robinhood: rh });
    }
    const [{ data: jobs }, { data: alerts }, { data: runs }, { data: lock }] = await Promise.all([
      db.from("treasury_jobs").select("*").order("created_at", { ascending: false }).limit(50),
      db
        .from("treasury_alerts")
        .select("*")
        .is("acknowledged_at", null)
        .order("created_at", { ascending: false })
        .limit(50),
      db.from("treasury_runs").select("*").order("started_at", { ascending: false }).limit(10),
      db.from("treasury_lock").select("*").eq("id", 1).maybeSingle(),
    ]);
    return {
      settings: s,
      splitter: sp,
      chain,
      chainError,
      keeperAddress: acct?.address.toLowerCase() ?? null,
      balances,
      secrets: {
        KEEPER_PRIVATE_KEY: !!acct,
        OPENSEA_API_KEY: hasEnv("OPENSEA_API_KEY"),
        RELAY_API_KEY: hasEnv("RELAY_API_KEY"),
        TELEGRAM_BOT_TOKEN: hasEnv("TELEGRAM_BOT_TOKEN"),
        ETH_RPC_URL: hasEnv("ETH_RPC_URL"),
        ROBINHOOD_RPC_URL: hasEnv("ROBINHOOD_RPC_URL"),
      },
      jobs: (jobs ?? []) as import("./treasury-keeper.server").Job[],
      alerts: (alerts ?? []) as {
        id: string;
        created_at: string;
        level: string;
        message: string;
        job_id: string | null;
      }[],
      runs: (runs ?? []) as {
        id: string;
        started_at: string;
        finished_at: string | null;
        trigger: string;
        dry_run: boolean;
        ok: boolean | null;
        log: import("./treasury-keeper.server").LogEntry[];
      }[],
      lastRunAt: (lock?.last_run_at as string | null) ?? null,
    };
  });

/** FeesSplit / PaidOut / Released / TargetSet history (scans new blocks, then reads the cache). */
export const adminTreasuryEvents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuper(context);
    const db = await admin();
    const k = await import("./treasury-keeper.server");
    const s = await k.loadSettings();
    const sp = await k.activeSplitter(s.splitter_chain_id);
    if (!sp) return { rows: [], scannedTo: null as number | null, behind: false };
    const m = await import("./treasury-market.server");
    const { SPLITTER_ABI } = await import("@/contracts/splitter");
    const pub = m.reader(m.apeChain(s.splitter_chain_id));
    const head = await pub.getBlockNumber();
    let from =
      BigInt((sp.scanned_block ?? sp.block_number ?? 0) as number) +
      (sp.scanned_block != null ? 1n : 0n);
    const names = new Set(["FeesSplit", "PaidOut", "Released", "TargetSet"]);
    let span = 50_000n;
    let chunks = 0;
    const started = Date.now();
    while (from <= head && chunks < 40 && Date.now() - started < 20_000) {
      const to = from + span - 1n > head ? head : from + span - 1n;
      let logs;
      try {
        logs = await pub.getContractEvents({
          address: sp.address as `0x${string}`,
          abi: SPLITTER_ABI,
          fromBlock: from,
          toBlock: to,
        });
      } catch (e) {
        if (span > 2_000n) {
          span /= 4n; // the RPC refused the range: smaller pieces
          continue;
        }
        throw e;
      }
      const rows = (
        logs as unknown as {
          eventName: string;
          args: Record<string, unknown>;
          blockNumber: bigint;
          logIndex: number;
          transactionHash: string;
        }[]
      )
        .filter((l) => names.has(l.eventName))
        .map((l) => ({
          chain_id: s.splitter_chain_id,
          splitter: sp.address,
          block_number: Number(l.blockNumber),
          log_index: l.logIndex,
          tx_hash: l.transactionHash.toLowerCase(),
          name: l.eventName,
          bucket: l.args["bucket"] != null ? Number(l.args["bucket"]) : null,
          amount_wei: l.args["amount"] != null ? String(l.args["amount"]) : null,
          target_wei: l.args["target"] != null ? String(l.args["target"]) : null,
          address: (l.args["to"] ?? l.args["from"] ?? null) as string | null,
        }));
      if (rows.length)
        await db
          .from("treasury_events")
          .upsert(rows, { onConflict: "chain_id,tx_hash,log_index", ignoreDuplicates: true });
      await db
        .from("treasury_splitters")
        .update({ scanned_block: Number(to) })
        .eq("id", sp.id);
      from = to + 1n;
      chunks++;
    }
    const { data } = await db
      .from("treasury_events")
      .select("*")
      .eq("chain_id", s.splitter_chain_id)
      .eq("splitter", sp.address)
      .order("block_number", { ascending: false })
      .order("log_index", { ascending: false })
      .limit(300);
    return {
      rows: (data ?? []) as {
        id: number;
        block_number: number;
        tx_hash: string;
        name: string;
        bucket: number | null;
        amount_wei: string | null;
        target_wei: string | null;
        address: string | null;
      }[],
      scannedTo: Number(from - 1n),
      behind: from <= head,
    };
  });

export const adminSaveTreasurySettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => settingsSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertSuper(context);
    const db = await admin();
    const k = await import("./treasury-keeper.server");
    const before = await k.loadSettings();
    if (data.fees_to_splitter && !(await k.activeSplitter(33139)))
      throw new Error(
        "Deploy and activate a splitter on ApeChain mainnet before sending Gotcha fees to it.",
      );
    const { error } = await db
      .from("app_config")
      .upsert(
        { key: "treasury", value: data, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
    if (error) throw new Error(error.message);
    await db.from("audit_log").insert({
      actor: context.userId,
      action: "treasury.settings",
      details: {
        dry_run: data.dry_run,
        kill_switch: data.kill_switch,
        fees_to_splitter: data.fees_to_splitter,
        changed_dry_run: before.dry_run !== data.dry_run,
      },
    });
    return { ok: true };
  });

/** Manual dashboard buttons: payoutAll / syncSurplus / release(bucket). Sent from the keeper wallet. */
export const adminTreasuryAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        action: z.enum(["payoutAll", "syncSurplus", "release"]),
        bucket: z.number().int().min(2).max(7).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertSuper(context);
    const k = await import("./treasury-keeper.server");
    const m = await import("./treasury-market.server");
    const { ctx, entries } = await k.manualCtx();
    const db = await admin();
    let tx: string | null = null;
    if (data.action === "release") {
      if (data.bucket == null) throw new Error("Pick a bucket.");
      const missing = k.preflight(ctx.s, data.bucket);
      if (missing)
        throw new Error(`Set the ${missing} in Treasury → Settings before releasing this bucket.`);
      const job = await k.startJob(ctx, data.bucket, true);
      if (!job) throw new Error(entries.at(-1)?.msg ?? "Release failed — see alerts.");
      tx = job.release_tx;
    } else {
      try {
        const r = await m.splitterTx(ctx.chainId, ctx.splitter, data.action);
        tx = r.hash;
      } catch (e) {
        const x = e as { shortMessage?: string; message?: string };
        throw new Error((x.shortMessage ?? x.message ?? "Transaction failed").split("\n")[0]!);
      }
    }
    await db.from("audit_log").insert({
      actor: context.userId,
      action: `treasury.${data.action}`,
      details: { bucket: data.bucket ?? null, tx },
    });
    return { tx };
  });

export const adminRunKeeper = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuper(context);
    const k = await import("./treasury-keeper.server");
    return k.runKeeper("manual", true);
  });

export const adminAckAlerts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertSuper(context);
    const db = await admin();
    let q = db
      .from("treasury_alerts")
      .update({ acknowledged_at: new Date().toISOString() })
      .is("acknowledged_at", null);
    if (data.id) q = q.eq("id", data.id);
    await q;
    return { ok: true };
  });

/** A failed job continues from its last good step (e.g. ETH already bridged → try buying again). */
export const adminRetryJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertSuper(context);
    const db = await admin();
    const { data: job } = await db
      .from("treasury_jobs")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (!job) throw new Error("Job not found.");
    if (job.status !== "failed") throw new Error("Only failed jobs can be retried.");
    if (!job.last_ok_status)
      throw new Error(
        "This job never got past the release, so there is nothing to continue. The keeper starts a new one when the bucket is ready.",
      );
    const { error } = await db
      .from("treasury_jobs")
      .update({
        status: job.last_ok_status,
        error: null,
        attempts: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    if (error)
      throw new Error(
        /treasury_jobs_open_uidx/.test(error.message)
          ? "Another job for this bucket is open; finish that one first."
          : error.message,
      );
    await db.from("audit_log").insert({
      actor: context.userId,
      action: "treasury.job_retry",
      details: { job_id: job.id, from: job.last_ok_status },
    });
    return { ok: true, status: job.last_ok_status as string };
  });

/** Close a failed job (after sorting out its funds by hand), so the bucket can start a new buy. */
export const adminCloseJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertSuper(context);
    const db = await admin();
    const { data: job } = await db
      .from("treasury_jobs")
      .select("id, status, note")
      .eq("id", data.id)
      .maybeSingle();
    if (!job) throw new Error("Job not found.");
    if (job.status !== "failed") throw new Error("Only failed jobs can be closed.");
    await db
      .from("treasury_jobs")
      .update({
        last_ok_status: null,
        note: `${job.note ? `${job.note} ` : ""}Closed by an admin.`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    await db.from("audit_log").insert({
      actor: context.userId,
      action: "treasury.job_closed",
      details: { job_id: job.id },
    });
    return { ok: true };
  });
