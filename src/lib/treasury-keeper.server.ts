// Gotcha Treasury keeper bot (server only). Runs every 10 minutes (pg_cron → POST /api/treasury-keeper) and from
// Admin → Treasury → "Run keeper now". Each run:
//   1. pays out Team + Operations when they hold APE (payoutAll);
//   2. prices the floors (OpenSea) and the APE needed to reach them (Relay EXACT_OUTPUT) and posts the targets
//      (buckets 4 and 5 always equal; only when a target moved more than target_move_pct);
//   3. moves every open buy job one or more steps forward; 4. starts a job for each enabled bucket that's ready.
// A job: releasing → released → bridging → bridged → buying → bought → delivering → delivered (or failed).
// Every step stores its tx hash before moving on, so a crashed run resumes and never releases or buys twice.
// Safety: DRY_RUN (default ON) sends nothing; kill switch; max spend per bucket; max slippage; a row lock.
import { getAddress, formatEther, type Hex } from "viem";
import {
  BUCKET_JOBS,
  DEAD_ADDRESS,
  withDefaults,
  type JobStatus,
  type TreasurySettings,
} from "./treasury-settings";
import { isSplitterChain, type SplitterChainId } from "@/contracts/splitter";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

export type Job = {
  id: string;
  chain_id: number;
  splitter: string;
  bucket: number;
  status: JobStatus;
  release_from_block: number | null;
  release_tx: string | null;
  released_ape_wei: string | null;
  relay_request_id: string | null;
  bridge_tx: string | null;
  bridge_expected_wei: string | null;
  dest_chain_id: number | null;
  listing_hash: string | null;
  nft_contract: string | null;
  token_id: string | null;
  price_wei: string | null;
  buy_tx: string | null;
  deliver_tx: string | null;
  note: string | null;
  error: string | null;
  attempts: number;
  last_ok_status: string | null;
  manual: boolean;
  created_at: string;
  updated_at: string;
};

export type LogEntry = { at: string; msg: string; data?: Record<string, string> };

const OPEN: JobStatus[] = [
  "releasing",
  "released",
  "bridging",
  "bridged",
  "buying",
  "bought",
  "delivering",
];
const STALE_MS = 10 * 60_000;
const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const fmt = (w: bigint | string) => `${Number(formatEther(BigInt(w))).toFixed(4)}`;

export async function loadSettings(): Promise<TreasurySettings> {
  const { data } = await (
    await admin()
  )
    .from("app_config")
    .select("value")
    .eq("key", "treasury")
    .maybeSingle();
  return withDefaults(data?.value as Partial<TreasurySettings> | null);
}

/** Target bookkeeping: what ETH each target was set for (used for the slippage check). */
async function loadTargetBasis(): Promise<
  Record<string, { ape: string; eth: string; at: string }>
> {
  const { data } = await (
    await admin()
  )
    .from("app_config")
    .select("value")
    .eq("key", "treasury_targets")
    .maybeSingle();
  return (data?.value as Record<string, { ape: string; eth: string; at: string }>) ?? {};
}
async function saveTargetBasis(v: Record<string, { ape: string; eth: string; at: string }>) {
  await (
    await admin()
  )
    .from("app_config")
    .upsert(
      { key: "treasury_targets", value: v, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
}

export async function activeSplitter(chainId: number) {
  const { data } = await (
    await admin()
  )
    .from("treasury_splitters")
    .select("*")
    .eq("chain_id", chainId)
    .eq("is_active", true)
    .maybeSingle();
  return (
    (data as {
      id: string;
      chain_id: number;
      address: string;
      block_number: number | null;
      scanned_block: number | null;
    } | null) ?? null
  );
}

/**
 * Where Gotcha spin payments go on `chainId`: the active splitter when "Send Gotcha fees to the splitter" is on
 * (ApeChain mainnet only), otherwise null (= the configured treasury wallet).
 */
export async function feeRecipient(chainId: number): Promise<string | null> {
  try {
    if (chainId !== 33139) return null;
    const s = await loadSettings();
    if (!s.fees_to_splitter) return null;
    const sp = await activeSplitter(33139);
    return sp ? sp.address.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Alert on the dashboard (and Telegram when TELEGRAM_BOT_TOKEN + chat ID are set). */
export async function raiseAlert(
  message: string,
  opts: { jobId?: string; level?: "error" | "warn" | "info"; settings?: TreasurySettings } = {},
) {
  const db = await admin();
  await db.from("treasury_alerts").insert({
    message: message.slice(0, 1000),
    level: opts.level ?? "error",
    job_id: opts.jobId ?? null,
  });
  const token = process.env["TELEGRAM_BOT_TOKEN"]?.trim();
  const chat = opts.settings?.telegram_chat_id?.trim();
  if (token && chat && (opts.level ?? "error") !== "info") {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text: `Gotcha Treasury ${opts.level === "warn" ? "warning" : "alert"}: ${message}`.slice(
          0,
          3500,
        ),
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
}

async function updateJob(id: string, patch: Partial<Job>) {
  await (
    await admin()
  )
    .from("treasury_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
}

type Ctx = {
  s: TreasurySettings;
  chainId: SplitterChainId;
  splitter: string;
  keeper: string;
  testnet: boolean;
  log: (msg: string, data?: Record<string, unknown>) => void;
};

function errText(e: unknown) {
  const x = e as { shortMessage?: string; message?: string };
  return (x?.shortMessage ?? x?.message ?? String(e)).split("\n")[0]!.slice(0, 300);
}

// ---------- targets ----------

async function priceTargets(
  ctx: Ctx,
  chain: Awaited<ReturnType<(typeof import("./treasury-market.server"))["readSplitter"]>>,
) {
  const m = await import("./treasury-market.server");
  const { s } = ctx;
  const plan: { bucket: number; slug: string; dest: "ethereum" | "robinhood" }[] = [];
  if ((s.buckets["4"]?.enabled || s.buckets["5"]?.enabled) && s.stonk_nft_slug)
    plan.push({ bucket: 4, slug: s.stonk_nft_slug, dest: "robinhood" });
  if (s.buckets["6"]?.enabled) plan.push({ bucket: 6, slug: s.bayc_slug, dest: "ethereum" });
  if (s.buckets["7"]?.enabled) plan.push({ bucket: 7, slug: s.mayc_slug, dest: "ethereum" });
  if (!plan.length) return ctx.log("Targets: no enabled buy buckets.");
  const basis = await loadTargetBasis();
  const next: Record<number, bigint> = {};
  for (const p of plan) {
    try {
      const listing = await m.bestListing(p.slug);
      if (!listing) {
        ctx.log(`Targets: no ETH listing found for ${p.slug}.`);
        continue;
      }
      const destId = p.dest === "ethereum" ? m.ETHEREUM_ID : s.robinhood_chain_id;
      const ethNeeded = listing.priceWei + m.eth(s.gas_allowance_eth[p.dest]);
      // Prices always come from mainnet routes (on Curtis there is no bridge; mainnet prices keep targets realistic).
      const q = await m.relayQuote({
        user: ctx.keeper,
        originChainId: 33139,
        destinationChainId: destId,
        amount: ethNeeded,
        tradeType: "EXACT_OUTPUT",
      });
      const target = q.amountIn + m.pct(q.amountIn, s.buffer_pct);
      next[p.bucket] = target;
      basis[String(p.bucket)] = {
        ape: target.toString(),
        eth: ethNeeded.toString(),
        at: new Date().toISOString(),
      };
      ctx.log(
        `Floor ${p.slug}: ${fmt(listing.priceWei)} ETH (+gas ${s.gas_allowance_eth[p.dest]}) ≈ ${fmt(q.amountIn)} APE → target ${fmt(target)} APE (+${s.buffer_pct}%).`,
      );
    } catch (e) {
      ctx.log(`Targets: couldn't price ${p.slug}: ${errText(e)}`);
    }
  }
  // Buckets 4 and 5 always get the same target (the StonkBroker floor).
  if (next[4] != null) {
    next[5] = next[4];
    basis["5"] = basis["4"]!;
  }
  const ids: bigint[] = [];
  const values: bigint[] = [];
  for (const [k, v] of Object.entries(next)) {
    const i = Number(k);
    const old = chain.buckets[i]!.target;
    const moved =
      old === 0n
        ? true
        : ((v > old ? v - old : old - v) * 10000n) / old >
          BigInt(Math.round(ctx.s.target_move_pct * 100));
    if (moved) {
      ids.push(BigInt(i));
      values.push(v);
    }
  }
  // Keep 4 and 5 together: if one moves, send both.
  if (ids.some((x) => x === 4n || x === 5n) && next[4] != null) {
    for (const b of [4n, 5n]) {
      if (ids.includes(b)) continue;
      ids.push(b);
      values.push(next[4]!);
    }
  }
  if (!ids.length) return ctx.log("Targets: unchanged (within the move threshold).");
  if (ctx.s.dry_run)
    return ctx.log(
      `DRY RUN: would setTargets([${ids.join(",")}], [${values.map(fmt).join(", ")}] APE).`,
    );
  const r = await m.splitterTx(ctx.chainId, ctx.splitter, "setTargets", [ids, values]);
  await saveTargetBasis(basis);
  ctx.log(`setTargets([${ids.join(",")}]) sent`, { tx: r.hash, ok: r.receipt?.status });
}

// ---------- jobs ----------

/** What a bucket still needs in Settings before it may release (null = ready). */
export function preflight(s: TreasurySettings, bucket: number): string | null {
  const spec = BUCKET_JOBS[bucket]!;
  const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
  if (spec.kind === "stock") return null;
  if (spec.chain === "robinhood" && !s.robinhood_rpc_url && !process.env["ROBINHOOD_RPC_URL"])
    return "Robinhood Chain RPC";
  if (spec.kind === "burn") return isAddr(s.stonk_token) ? null : "$STONKBROKER token address";
  if (spec.chain === "ethereum" && !isAddr(s.prize_wallet_ethereum))
    return "prize wallet on Ethereum";
  if (spec.chain === "robinhood" && !isAddr(s.prize_wallet_robinhood))
    return "prize wallet on Robinhood Chain";
  if (bucket === 4 && !s.stonk_nft_slug) return "StonkBroker NFT OpenSea slug";
  return null;
}

/** A failed job whose APE was already released (ETH, tokens or an NFT may be in the keeper wallet). */
async function unresolvedFailure(ctx: Ctx, bucket: number) {
  const { data } = await (
    await admin()
  )
    .from("treasury_jobs")
    .select("id")
    .eq("chain_id", ctx.chainId)
    .eq("splitter", ctx.splitter)
    .eq("bucket", bucket)
    .eq("status", "failed")
    .not("last_ok_status", "is", null)
    .limit(1);
  return !!data?.length;
}

async function openJob(ctx: Ctx, bucket: number) {
  const { data } = await (
    await admin()
  )
    .from("treasury_jobs")
    .select("*")
    .eq("chain_id", ctx.chainId)
    .eq("splitter", ctx.splitter)
    .eq("bucket", bucket)
    .in("status", OPEN)
    .maybeSingle();
  return (data as Job | null) ?? null;
}

/** Releases a ready bucket and records the job (the open-job unique index stops a second job for the bucket). */
export async function startJob(ctx: Ctx, bucket: number, manual = false): Promise<Job | null> {
  const m = await import("./treasury-market.server");
  const db = await admin();
  const block = await m.reader(m.apeChain(ctx.chainId)).getBlockNumber();
  const { data: job, error } = await db
    .from("treasury_jobs")
    .insert({
      chain_id: ctx.chainId,
      splitter: ctx.splitter,
      bucket,
      status: "releasing",
      release_from_block: Number(block),
      manual,
    })
    .select("*")
    .single();
  if (error) {
    ctx.log(`Bucket ${bucket}: a job is already open (${error.message.slice(0, 80)}).`);
    return null;
  }
  try {
    const r = await m.splitterTx(ctx.chainId, ctx.splitter, "release", [BigInt(bucket)]);
    await updateJob(job.id, { release_tx: r.hash.toLowerCase() });
    if (!r.receipt) {
      ctx.log(`Bucket ${bucket}: release sent, confirming next run.`, { tx: r.hash });
      return { ...job, release_tx: r.hash };
    }
    if (r.receipt.status !== "success") throw new Error("release() reverted");
    const amount = m.releasedAmount(r.receipt.logs as never, bucket);
    const kind = BUCKET_JOBS[bucket]!.kind;
    const patch: Partial<Job> =
      kind === "stock" || ctx.testnet
        ? {
            status: "delivered",
            released_ape_wei: amount?.toString() ?? null,
            note:
              kind === "stock"
                ? "Released to the bucket's recipient."
                : "Testnet: released only (no bridge or purchase on Curtis).",
          }
        : {
            status: "released",
            last_ok_status: "released",
            released_ape_wei: amount?.toString() ?? null,
          };
    await updateJob(job.id, patch);
    ctx.log(`Bucket ${bucket}: released ${amount != null ? fmt(amount) : "?"} APE.`, {
      tx: r.hash,
    });
    return { ...job, ...patch, release_tx: r.hash } as Job;
  } catch (e) {
    await updateJob(job.id, { status: "failed", error: errText(e) });
    await raiseAlert(`Bucket ${bucket}: release failed: ${errText(e)}`, {
      jobId: job.id,
      settings: ctx.s,
    });
    return null;
  }
}

/** Moves a job forward as far as it can this run. */
export async function advanceJob(ctx: Ctx, job: Job) {
  const m = await import("./treasury-market.server");
  const { s } = ctx;
  const spec = BUCKET_JOBS[job.bucket]!;
  const age = Date.now() - new Date(job.updated_at).getTime();
  const ape = m.apeChain(ctx.chainId);
  const dest = spec.chain === "ethereum" ? m.ethChain(s) : m.rhChain(s);
  const fail = async (msg: string) => {
    await updateJob(job.id, {
      status: "failed",
      error: msg.slice(0, 300),
      last_ok_status: job.last_ok_status ?? job.status,
    });
    await raiseAlert(`Bucket ${job.bucket} job: ${msg}`, { jobId: job.id, settings: s });
    ctx.log(`Bucket ${job.bucket}: FAILED — ${msg}`);
  };
  const set = async (patch: Partial<Job>) => {
    Object.assign(job, patch);
    await updateJob(job.id, patch);
  };

  for (let step = 0; step < 6; step++) {
    switch (job.status) {
      case "releasing": {
        const pub = m.reader(ape);
        if (job.release_tx) {
          const rc = await pub
            .getTransactionReceipt({ hash: job.release_tx as Hex })
            .catch(() => null);
          if (!rc) return ctx.log(`Bucket ${job.bucket}: release still confirming.`);
          if (rc.status !== "success") return fail("release() reverted");
          const amount = m.releasedAmount(rc.logs as never, job.bucket);
          const done = spec.kind === "stock" || ctx.testnet;
          await set(
            done
              ? {
                  status: "delivered",
                  released_ape_wei: amount?.toString() ?? null,
                  note:
                    spec.kind === "stock"
                      ? "Released to the bucket's recipient."
                      : "Testnet: released only.",
                }
              : {
                  status: "released",
                  last_ok_status: "released",
                  released_ape_wei: amount?.toString() ?? null,
                },
          );
          break;
        }
        // No hash saved (crash right after sending?): look for the Released event since the job began.
        if (age < STALE_MS) return ctx.log(`Bucket ${job.bucket}: waiting to confirm the release.`);
        const { SPLITTER_ABI } = await import("@/contracts/splitter");
        const logs = await pub
          .getContractEvents({
            address: getAddress(job.splitter),
            abi: SPLITTER_ABI,
            eventName: "Released",
            fromBlock: BigInt(job.release_from_block ?? 0),
            args: { bucket: BigInt(job.bucket) } as never,
          })
          .catch(() => []);
        const hit = (logs as { transactionHash: string; args: { amount?: bigint } }[])[0];
        if (hit)
          await set({
            status: spec.kind === "stock" || ctx.testnet ? "delivered" : "released",
            release_tx: hit.transactionHash,
            released_ape_wei: hit.args.amount?.toString() ?? null,
            last_ok_status: "released",
          });
        else return fail("The release was never sent (safe to start again).");
        break;
      }
      case "released": {
        if (spec.kind === "stock" || ctx.testnet) return set({ status: "delivered" });
        const keeperBal = await m.reader(ape).getBalance({ address: getAddress(ctx.keeper) });
        const reserve = m.eth(s.ape_gas_reserve);
        const released = BigInt(job.released_ape_wei ?? "0");
        const amount = released < keeperBal - reserve ? released : keeperBal - reserve;
        if (amount <= 0n)
          return fail(
            `The keeper wallet has ${fmt(keeperBal)} APE, not enough to bridge after keeping ${s.ape_gas_reserve} APE for gas.`,
          );
        const destId = spec.chain === "ethereum" ? m.ETHEREUM_ID : s.robinhood_chain_id;
        let quote;
        if (spec.kind === "burn") {
          if (!/^0x[0-9a-fA-F]{40}$/.test(s.stonk_token))
            return fail("Set the $STONKBROKER token address in Settings.");
          quote = await m.relayQuote({
            user: ctx.keeper,
            originChainId: ctx.chainId,
            destinationChainId: destId,
            destinationCurrency: s.stonk_token,
            amount,
            tradeType: "EXACT_INPUT",
            recipient: DEAD_ADDRESS,
            slippageBps: Math.round(s.slippage_pct * 100),
          });
        } else {
          quote = await m.relayQuote({
            user: ctx.keeper,
            originChainId: ctx.chainId,
            destinationChainId: destId,
            amount,
            tradeType: "EXACT_INPUT",
            slippageBps: Math.round(s.slippage_pct * 100),
          });
          const basis = (await loadTargetBasis())[String(job.bucket)];
          if (basis) {
            const expected =
              (BigInt(basis.eth) * BigInt(released)) / BigInt(basis.ape === "0" ? "1" : basis.ape);
            const floor = expected - m.pct(expected, s.slippage_pct);
            if (quote.amountOut < floor) {
              await raiseAlert(
                `Bucket ${job.bucket}: bridge quote ${fmt(quote.amountOut)} ETH is worse than ${s.slippage_pct}% below the expected ${fmt(expected)} ETH; holding the APE and retrying next run.`,
                { jobId: job.id, level: "warn", settings: s },
              );
              return ctx.log(`Bucket ${job.bucket}: slippage too high, waiting.`);
            }
          }
        }
        if (s.dry_run)
          return ctx.log(
            `DRY RUN: would bridge ${fmt(amount)} APE → ${fmt(quote.amountOut)} on chain ${destId}.`,
          );
        // Save the request before sending: if we crash, Relay's status for it tells whether it was sent.
        await set({
          status: "bridging",
          relay_request_id: quote.requestId,
          bridge_expected_wei: quote.amountOut.toString(),
          dest_chain_id: destId,
          last_ok_status: "released",
        });
        try {
          const tx = await m.relayExecute(quote, ape);
          await set({ bridge_tx: tx?.toLowerCase() ?? null });
          ctx.log(
            `Bucket ${job.bucket}: bridging ${fmt(amount)} APE (expect ${fmt(quote.amountOut)}).`,
            { tx, requestId: quote.requestId },
          );
        } catch (e) {
          await set({ status: "released", relay_request_id: null, bridge_expected_wei: null });
          return fail(`Bridge transaction failed: ${errText(e)}`);
        }
        return; // the bridge takes a few minutes: next run
      }
      case "bridging": {
        if (!job.relay_request_id) return set({ status: "released" });
        const st = await m
          .relayStatus(job.relay_request_id)
          .catch(() => ({ status: "unknown", txHashes: [] as string[] }));
        if (st.status === "success") {
          const done = spec.kind === "burn";
          await set(
            done
              ? {
                  status: "delivered",
                  deliver_tx: st.txHashes[0] ?? null,
                  note: "Bought $STONKBROKER and sent it to 0x…dEaD.",
                }
              : { status: "bridged", last_ok_status: "bridged" },
          );
          ctx.log(`Bucket ${job.bucket}: bridge complete.`);
          if (done) return;
          break;
        }
        if (st.status === "failure" || st.status === "refund")
          return fail(
            `Relay ${st.status}: the APE ${st.status === "refund" ? "was refunded to the keeper wallet" : "may need checking on relay.link"}.`,
          );
        if (st.status === "unknown" && !job.bridge_tx && age > STALE_MS)
          return set({ status: "released", relay_request_id: null });
        return ctx.log(`Bucket ${job.bucket}: bridge ${st.status}.`);
      }
      case "bridged": {
        const slug =
          job.bucket === 4 ? s.stonk_nft_slug : job.bucket === 6 ? s.bayc_slug : s.mayc_slug;
        const listing = await m.bestListing(slug);
        if (!listing)
          return ctx.log(`Bucket ${job.bucket}: no listing for ${slug}; retrying next run.`);
        if (
          job.bucket === 4 &&
          s.stonk_nft_contract &&
          listing.contract !== s.stonk_nft_contract.toLowerCase()
        )
          return fail(
            `Cheapest ${slug} listing is for contract ${short(listing.contract)}, not the configured StonkBroker contract.`,
          );
        const max = m.eth(s.buckets[String(job.bucket)]?.max_spend_eth ?? "0");
        if (listing.priceWei > max)
          return ctx.log(
            `Bucket ${job.bucket}: floor ${fmt(listing.priceWei)} ETH is above the max spend ${fmt(max)} ETH; holding the ETH.`,
          );
        const bal = await m.reader(dest).getBalance({ address: getAddress(ctx.keeper) });
        const need = listing.priceWei + m.eth(s.gas_allowance_eth[spec.chain!]);
        if (need > bal) {
          await raiseAlert(
            `Bucket ${job.bucket}: cheapest listing ${fmt(listing.priceWei)} ETH (+gas) is above the ${fmt(bal)} ETH received; keeping the ETH and retrying next run.`,
            { jobId: job.id, level: "warn", settings: s },
          );
          return ctx.log(`Bucket ${job.bucket}: listing above ETH received; not buying.`);
        }
        if (s.dry_run)
          return ctx.log(
            `DRY RUN: would buy ${slug} #${listing.tokenId} for ${fmt(listing.priceWei)} ETH.`,
          );
        const tx = await m.fulfillListing(listing, getAddress(ctx.keeper));
        const w = m.writer(dest);
        const pub = m.reader(dest);
        await pub.call({ account: w.account, to: tx.to, data: tx.data, value: tx.value }); // simulate (throws on revert)
        await set({
          status: "buying",
          listing_hash: listing.hash,
          nft_contract: listing.contract,
          token_id: listing.tokenId,
          price_wei: listing.priceWei.toString(),
          buy_tx: null,
          last_ok_status: "bridged",
        });
        const hash = await w.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value,
          chain: w.chain,
          account: w.account!,
        });
        await set({ buy_tx: hash.toLowerCase() });
        ctx.log(
          `Bucket ${job.bucket}: buying #${listing.tokenId} for ${fmt(listing.priceWei)} ETH.`,
          { tx: hash },
        );
        const rc = await pub
          .waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 3000 })
          .catch(() => null);
        if (!rc) return;
        if (rc.status !== "success") {
          await set({ status: "bridged", attempts: job.attempts + 1, buy_tx: null });
          if (job.attempts + 1 >= 3)
            await raiseAlert(
              `Bucket ${job.bucket}: buying failed ${job.attempts + 1} times (listings sold first?).`,
              { jobId: job.id, settings: s },
            );
          return;
        }
        await set({ status: "bought", last_ok_status: "bought" });
        break;
      }
      case "buying": {
        const pub = m.reader(dest);
        if (job.buy_tx) {
          const rc = await pub.getTransactionReceipt({ hash: job.buy_tx as Hex }).catch(() => null);
          if (!rc) return ctx.log(`Bucket ${job.bucket}: purchase still confirming.`);
          if (rc.status !== "success")
            return set({ status: "bridged", buy_tx: null, attempts: job.attempts + 1 });
          await set({ status: "bought", last_ok_status: "bought" });
          break;
        }
        if (age < STALE_MS || !job.nft_contract || !job.token_id) return;
        const owner = await pub
          .readContract({
            address: getAddress(job.nft_contract),
            abi: m.ERC721_ABI,
            functionName: "ownerOf",
            args: [BigInt(job.token_id)],
          })
          .catch(() => null);
        await set(
          owner && owner.toLowerCase() === ctx.keeper
            ? { status: "bought", last_ok_status: "bought" }
            : { status: "bridged" },
        );
        break;
      }
      case "bought": {
        const prize =
          spec.chain === "ethereum" ? s.prize_wallet_ethereum : s.prize_wallet_robinhood;
        if (!/^0x[0-9a-fA-F]{40}$/.test(prize))
          return fail(
            `Set the prize wallet for ${spec.chain} in Settings (the NFT is in the keeper wallet).`,
          );
        if (s.dry_run) return ctx.log(`DRY RUN: would send #${job.token_id} to the prize wallet.`);
        const w = m.writer(dest);
        const pub = m.reader(dest);
        await set({ status: "delivering", deliver_tx: null });
        const hash = await w.writeContract({
          address: getAddress(job.nft_contract!),
          abi: m.ERC721_ABI,
          functionName: "safeTransferFrom",
          args: [getAddress(ctx.keeper), getAddress(prize), BigInt(job.token_id!)],
          chain: w.chain,
          account: w.account!,
        });
        await set({ deliver_tx: hash.toLowerCase() });
        const rc = await pub
          .waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 3000 })
          .catch(() => null);
        if (rc?.status === "success") {
          await set({ status: "delivered", note: `Sent to prize wallet ${short(prize)}.` });
          ctx.log(`Bucket ${job.bucket}: delivered #${job.token_id} to ${short(prize)}.`, {
            tx: hash,
          });
          await raiseAlert(
            `Bucket ${job.bucket}: bought #${job.token_id} for ${fmt(job.price_wei ?? "0")} ETH and sent it to the prize wallet.`,
            { jobId: job.id, level: "info", settings: s },
          );
        } else if (rc) await set({ status: "bought", deliver_tx: null });
        return;
      }
      case "delivering": {
        const pub = m.reader(dest);
        const prize = (
          spec.chain === "ethereum" ? s.prize_wallet_ethereum : s.prize_wallet_robinhood
        ).toLowerCase();
        if (job.deliver_tx) {
          const rc = await pub
            .getTransactionReceipt({ hash: job.deliver_tx as Hex })
            .catch(() => null);
          if (!rc) return;
          return set(
            rc.status === "success"
              ? { status: "delivered", note: `Sent to prize wallet ${short(prize)}.` }
              : { status: "bought", deliver_tx: null },
          );
        }
        if (age < STALE_MS) return;
        const owner = await pub
          .readContract({
            address: getAddress(job.nft_contract!),
            abi: m.ERC721_ABI,
            functionName: "ownerOf",
            args: [BigInt(job.token_id!)],
          })
          .catch(() => null);
        return set(owner?.toLowerCase() === prize ? { status: "delivered" } : { status: "bought" });
      }
      default:
        return;
    }
  }
}

// ---------- the run ----------

export async function runKeeper(trigger: "cron" | "manual", force = false) {
  const db = await admin();
  const { data: locked, error: lockErr } = await db.rpc("treasury_try_lock", {
    _hold_seconds: 600,
    _min_gap_seconds: trigger === "cron" ? 480 : 0,
    _force: force,
  });
  if (lockErr)
    return { ran: false, reason: "The treasury turns on after the database update (0023)." };
  if (!locked)
    return {
      ran: false,
      reason: "Another keeper run is in progress or one ran in the last 8 minutes.",
    };
  const s = await loadSettings();
  const entries: LogEntry[] = [];
  const log = (msg: string, data?: Record<string, unknown>) => {
    entries.push({
      at: new Date().toISOString(),
      msg,
      ...(data
        ? { data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) }
        : {}),
    });
  };
  const { data: run } = await db
    .from("treasury_runs")
    .insert({ trigger, dry_run: s.dry_run })
    .select("id")
    .single();
  let ok = true;
  try {
    if (s.kill_switch) {
      log("Kill switch is ON: nothing done.");
      return { ran: true, entries };
    }
    const chainId = s.splitter_chain_id;
    if (!isSplitterChain(chainId)) throw new Error("Bad splitter network in Settings.");
    const sp = await activeSplitter(chainId);
    if (!sp) {
      log("No active splitter on this network (Treasury → Deploy → Make active).");
      return { ran: true, entries };
    }
    const m = await import("./treasury-market.server");
    const acct = m.keeperAccount();
    if (!acct) throw new Error("KEEPER_PRIVATE_KEY isn't set (Lovable → Secrets).");
    const keeper = acct.address.toLowerCase();
    const chain = await m.readSplitter(chainId, sp.address);
    if (keeper !== chain.keeper && keeper !== chain.owner)
      throw new Error(
        `The keeper key (${short(keeper)}) is not the splitter's keeper (${short(chain.keeper)}) or owner.`,
      );
    const ctx: Ctx = {
      s,
      chainId,
      splitter: sp.address.toLowerCase(),
      keeper,
      testnet: chainId === 33111,
      log,
    };
    log(
      `${s.dry_run ? "DRY RUN — " : ""}splitter ${short(sp.address)} on ${chainId === 33111 ? "Curtis" : "ApeChain"}; contract holds ${fmt(chain.balance)} APE.`,
    );

    // 1. Team + Operations
    if (chain.buckets[0]!.balance > 0n || chain.buckets[1]!.balance > 0n) {
      if (s.dry_run)
        log(
          `DRY RUN: would payoutAll() (Team ${fmt(chain.buckets[0]!.balance)}, Ops ${fmt(chain.buckets[1]!.balance)} APE).`,
        );
      else {
        const r = await m.splitterTx(chainId, sp.address, "payoutAll");
        log("payoutAll() sent", { tx: r.hash, ok: r.receipt?.status });
      }
    }

    // 2. Targets
    try {
      await priceTargets(ctx, chain);
    } catch (e) {
      log(`Targets failed: ${errText(e)}`);
      await raiseAlert(`Setting targets failed: ${errText(e)}`, { settings: s, level: "warn" });
    }

    // 3. Open jobs
    const { data: open } = await db
      .from("treasury_jobs")
      .select("*")
      .eq("chain_id", chainId)
      .eq("splitter", ctx.splitter)
      .in("status", OPEN)
      .order("created_at");
    for (const job of (open ?? []) as Job[]) {
      try {
        await advanceJob(ctx, job);
      } catch (e) {
        log(`Bucket ${job.bucket}: step error (will retry): ${errText(e)}`);
        await updateJob(job.id, { error: errText(e), attempts: job.attempts + 1 });
        if (job.attempts + 1 >= 5)
          await raiseAlert(`Bucket ${job.bucket} job stuck at "${job.status}": ${errText(e)}`, {
            jobId: job.id,
            settings: s,
          });
      }
    }

    // 4. New buys for ready buckets
    const fresh = await m.readSplitter(chainId, sp.address);
    for (let i = 2; i <= 7; i++) {
      if (!s.buckets[String(i)]?.enabled) continue;
      if (!fresh.buckets[i]!.ready) continue;
      // Buy buckets only release a priced target (target 0 would release the whole balance before any floor is known).
      if (BUCKET_JOBS[i]!.kind !== "stock" && fresh.buckets[i]!.target === 0n) {
        log(`Bucket ${i}: no floor target yet; not releasing.`);
        continue;
      }
      if (await openJob(ctx, i)) continue;
      const missing = preflight(s, i);
      if (missing) {
        log(`Bucket ${i}: ready, but set the ${missing} in Settings first; not releasing.`);
        continue;
      }
      if (await unresolvedFailure(ctx, i)) {
        log(
          `Bucket ${i}: a failed job still holds released funds — Retry or Close it on the Keeper tab before a new release.`,
        );
        continue;
      }
      const amount =
        fresh.buckets[i]!.target === 0n ? fresh.buckets[i]!.balance : fresh.buckets[i]!.target;
      if (s.dry_run) {
        log(
          `DRY RUN: bucket ${i} is ready — would release ${fmt(amount)} APE and ${BUCKET_JOBS[i]!.label.toLowerCase()}.`,
        );
        continue;
      }
      const job = await startJob(ctx, i);
      if (job && job.status === "released") {
        try {
          await advanceJob(ctx, job);
        } catch (e) {
          log(`Bucket ${i}: step error (will retry): ${errText(e)}`);
        }
      }
    }
    return { ran: true, entries };
  } catch (e) {
    ok = false;
    log(`Run failed: ${errText(e)}`);
    await raiseAlert(`Keeper run failed: ${errText(e)}`, { settings: s });
    return { ran: true, entries };
  } finally {
    if (run?.id)
      await db
        .from("treasury_runs")
        .update({ finished_at: new Date().toISOString(), ok, log: entries })
        .eq("id", run.id);
    await db.rpc("treasury_unlock");
  }
}

/** Context for manual dashboard actions (same checks as a run). */
export async function manualCtx() {
  const s = await loadSettings();
  if (s.kill_switch)
    throw new Error("The kill switch is ON. Turn it off in Treasury → Settings first.");
  const chainId = s.splitter_chain_id;
  const sp = await activeSplitter(chainId);
  if (!sp) throw new Error("No active splitter on this network.");
  const m = await import("./treasury-market.server");
  const acct = m.keeperAccount();
  if (!acct) throw new Error("KEEPER_PRIVATE_KEY isn't set (Lovable → Secrets).");
  const entries: LogEntry[] = [];
  const ctx: Ctx = {
    s,
    chainId,
    splitter: sp.address.toLowerCase(),
    keeper: acct.address.toLowerCase(),
    testnet: chainId === 33111,
    log: (msg) => entries.push({ at: new Date().toISOString(), msg }),
  };
  return { ctx, entries, sp };
}
