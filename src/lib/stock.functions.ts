// Stock certificates (drizzle 0020). A stock certificate is an NFT (StonkBrokers "Stonk Certificate" on Robinhood
// Chain) whose token-bound wallet holds stock tokens; owning the NFT means controlling them. A prize becomes one
// when an admin lists the certificate token IDs the project's custody wallet holds for it. Each win in a real draw
// gets one token ID, and the winner chooses how to receive it:
//   • to a wallet — the app sends the NFT from the custody wallet to one of the winner's linked wallets, right away;
//   • by email — the app emails a one-time claim link to the account email; the winner opens it, picks a wallet,
//     and the app sends it there.
// Sending is guarded so a certificate can only go out once (status lock + an ownerOf check before every send).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { StockConfig } from "./stock-chain.server";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}
async function audit(actor: string | null, action: string, details: unknown) {
  await (await admin()).from("audit_log").insert({ actor, action, details: details as any });
}
async function assertAdmin(ctx: { supabase: any; userId: string }) {
  const { data } = await ctx.supabase.rpc("has_role", { _user_id: ctx.userId, _role: "admin" });
  if (!data) throw new Error("Forbidden");
}
async function assertSuper(ctx: { supabase: any; userId: string }) {
  await assertAdmin(ctx);
  const { superAdminId } = await import("./roles.server");
  if ((await superAdminId(await admin())) !== ctx.userId) throw new Error("Only the super admin can do this.");
}

export type StockStatus = "unclaimed" | "emailed" | "sending" | "sent" | "failed";
type StockRow = {
  id: string;
  spin_id: string;
  user_id: string;
  prize_id: string | null;
  prize_name: string;
  chain_id: number | null;
  contract: string | null;
  token_id: string | null;
  status: StockStatus;
  delivery: "wallet" | "email" | null;
  to_wallet: string | null;
  email: string | null;
  claim_rand: string | null;
  emailed_at: string | null;
  tx_hash: string | null;
  error: string | null;
  send_started_at: string | null;
  sent_at: string | null;
  created_at: string;
};

const addr = z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/, "Enter a wallet address (0x… 42 characters)").transform((a) => a.toLowerCase());
const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
/** Wallet-only accounts get a made-up address at sign-in; it can't receive mail. */
const realEmail = (e?: string | null) => (e && /@/.test(e) && !/@privy\.apegamesgotcha\.app$/i.test(e) ? e : null);
function maskEmail(e: string) {
  const [u = "", d = ""] = e.split("@");
  return `${u.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, u.length - 2)))}@${d}`;
}
/** Where links in emails point. Only our own sites (or a local test server); otherwise the main site. */
function siteOrigin(origin?: string | null) {
  const o = (origin ?? "").replace(/\/$/, "");
  if (/^https:\/\/([a-z0-9-]+\.)*(apegamesgotcha\.com|lovable\.app|lovableproject\.com)$/i.test(o)) return o;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)) return o;
  return "https://apegamesgotcha.com";
}

async function stockConfig(): Promise<StockConfig> {
  const { data } = await (await admin()).from("app_config").select("value").eq("key", "stock").maybeSingle();
  const v = (data?.value ?? {}) as Partial<StockConfig>;
  return {
    chain_id: typeof v.chain_id === "number" && v.chain_id > 0 ? v.chain_id : null,
    chain_name: v.chain_name || null,
    rpc_url: v.rpc_url || null,
    explorer_url: v.explorer_url || null,
    contract: v.contract ? String(v.contract).toLowerCase() : null,
  };
}

/** Prizes that are stock certificates, with their token IDs. */
async function stockPrizes() {
  const { data, error } = await (await admin()).from("prizes").select("id, name, stock_token_ids").not("stock_token_ids", "is", null);
  if (error) return null; // database update not applied yet
  return ((data ?? []) as { id: string; name: string; stock_token_ids: string[] | null }[]).filter((p) => p.stock_token_ids?.length);
}

/**
 * Makes sure every stock certificate won in a real draw has its record, and gives records without a certificate
 * yet the next free token ID of their prize (a token goes to one winner only: unique in the database).
 */
async function ensureStockCertificates(userId?: string) {
  const prizes = await stockPrizes();
  if (!prizes?.length) return;
  const db = await admin();
  const cfg = await stockConfig();
  const byId = new Map(prizes.map((p) => [p.id, p]));
  let q = db.from("spins").select("id, user_id, prize_id, prize_name").eq("status", "fulfilled").in("prize_id", [...byId.keys()]).limit(1000);
  if (userId) q = q.eq("user_id", userId);
  const { data: spins } = await q;
  if (spins?.length) {
    const { data: have } = await db.from("stock_certificates").select("spin_id").in("spin_id", (spins as any[]).map((s) => s.id));
    const done = new Set(((have ?? []) as { spin_id: string }[]).map((h) => h.spin_id));
    const rows = (spins as any[])
      .filter((s) => !done.has(s.id))
      .map((s) => ({ spin_id: s.id, user_id: s.user_id, prize_id: s.prize_id, prize_name: s.prize_name ?? byId.get(s.prize_id)!.name }));
    if (rows.length) await db.from("stock_certificates").upsert(rows, { onConflict: "spin_id", ignoreDuplicates: true });
  }
  if (!cfg.contract) return; // token IDs are handed out once the contract is set
  let w = db.from("stock_certificates").select("id, prize_id").is("token_id", null).in("status", ["unclaimed", "emailed", "failed"]).order("created_at").limit(200);
  if (userId) w = w.eq("user_id", userId);
  const { data: waiting } = await w;
  if (!waiting?.length) return;
  const { data: used } = await db.from("stock_certificates").select("token_id").eq("contract", cfg.contract).not("token_id", "is", null);
  const taken = new Set(((used ?? []) as { token_id: string }[]).map((u) => u.token_id));
  for (const r of waiting as { id: string; prize_id: string | null }[]) {
    const p = r.prize_id ? byId.get(r.prize_id) : undefined;
    for (const t of p?.stock_token_ids ?? []) {
      if (taken.has(t)) continue;
      taken.add(t);
      const { data: ok, error } = await db
        .from("stock_certificates")
        .update({ token_id: t, contract: cfg.contract, chain_id: cfg.chain_id, updated_at: new Date().toISOString() })
        .eq("id", r.id)
        .is("token_id", null)
        .select("id");
      if (!error && ok?.length) break; // assigned; a 23505 means someone else just took it: try the next one
      if (!error) break; // this record got a token meanwhile
    }
  }
}

/** Sends that were still confirming: settle them (sent / failed) from the chain. */
async function settleSending(rows: StockRow[]) {
  const open = rows.filter((r) => r.status === "sending");
  if (!open.length) return false;
  const chain = await import("./stock-chain.server");
  const cfg = await stockConfig();
  const db = await admin();
  let changed = false;
  for (const r of open) {
    const now = new Date().toISOString();
    try {
      if (r.tx_hash) {
        const s = await chain.transferState(cfg, r.tx_hash);
        if (s === "pending") continue;
        await db
          .from("stock_certificates")
          .update(s === "ok" ? { status: "sent", sent_at: now, claim_rand: null, error: null, updated_at: now } : { status: "failed", tx_hash: null, error: "The transfer was reverted on-chain.", updated_at: now })
          .eq("id", r.id)
          .eq("status", "sending");
        changed = true;
      } else if (r.send_started_at && Date.now() - new Date(r.send_started_at).getTime() > 3 * 60_000 && r.contract && r.token_id) {
        // Interrupted before the hash was saved: the owner on-chain tells whether it went out.
        const owner = await chain.ownerOf(cfg, r.contract, r.token_id);
        const sent = owner === r.to_wallet;
        await db
          .from("stock_certificates")
          .update(sent ? { status: "sent", sent_at: now, claim_rand: null, error: null, updated_at: now } : { status: "failed", error: "Sending was interrupted. Try again.", updated_at: now })
          .eq("id", r.id)
          .eq("status", "sending");
        changed = true;
      }
    } catch {
      /* chain busy: look again next time */
    }
  }
  return changed;
}

/**
 * Sends a certificate NFT to `to`. Locks the record first (only one send at a time, never after it was sent),
 * checks the custody wallet still owns the token, sends, and waits briefly for the confirmation.
 */
async function deliver(c: StockRow, to: string, delivery: "wallet" | "email", actor: string | null) {
  const chain = await import("./stock-chain.server");
  const cfg = await stockConfig();
  const missing = chain.stockMissing(cfg);
  if (missing.length) throw new Error("Stock certificates can't be sent yet: the team is finishing the setup. Try again later.");
  if (!c.token_id || !c.contract) throw new Error("Your certificate is being prepared by the team. Try again a little later.");
  if (c.contract !== cfg.contract) throw new Error("This certificate's collection changed. The team has to give it a new certificate first.");
  const db = await admin();
  const now = new Date().toISOString();
  const { data: locked } = await db
    .from("stock_certificates")
    .update({ status: "sending", delivery, to_wallet: to, send_started_at: now, error: null, tx_hash: null, updated_at: now })
    .eq("id", c.id)
    .in("status", ["unclaimed", "emailed", "failed"])
    .select("id");
  if (!locked?.length) throw new Error("This certificate is already being sent, or was sent.");

  const fail = async (msg: string) => {
    await db.from("stock_certificates").update({ status: "failed", error: msg.slice(0, 300), updated_at: new Date().toISOString() }).eq("id", c.id).eq("status", "sending");
    await audit(actor, "stock.failed", { id: c.id, token_id: c.token_id, to, error: msg.slice(0, 300) });
  };
  let hash: string;
  try {
    const owner = await chain.ownerOf(cfg, c.contract, c.token_id);
    if (owner === to) {
      await db.from("stock_certificates").update({ status: "sent", sent_at: now, claim_rand: null, updated_at: now }).eq("id", c.id);
      return { state: "sent" as const, tx: null };
    }
    const custody = chain.custodyAccount()!.address.toLowerCase();
    if (owner !== custody) {
      await fail(`The custody wallet doesn't hold certificate #${c.token_id} (owner ${short(owner)}).`);
      throw new Error("This certificate isn't ready to send. The team has been told and will sort it out.");
    }
    hash = await chain.sendCertificate(cfg, c.contract, c.token_id, to);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/team has been told/.test(msg)) throw e;
    const { chainErrorMessage } = await import("./rpc.server");
    const friendly = /ERC721Receiver|non ERC721|onERC721Received/i.test(msg)
      ? "That wallet can't receive NFTs. Choose another wallet."
      : /insufficient funds|gas/i.test(msg)
        ? "The prize wallet needs more gas. The team has been told; try again later."
        : chainErrorMessage(e, "send the certificate");
    await fail(friendly);
    throw new Error(friendly);
  }
  await db.from("stock_certificates").update({ tx_hash: hash.toLowerCase(), updated_at: new Date().toISOString() }).eq("id", c.id);
  await audit(actor, "stock.sent", { id: c.id, token_id: c.token_id, to, tx: hash, delivery });
  const s = await chain.transferState(cfg, hash, 25_000);
  const done = new Date().toISOString();
  if (s === "ok") {
    await db.from("stock_certificates").update({ status: "sent", sent_at: done, claim_rand: null, updated_at: done }).eq("id", c.id);
    return { state: "sent" as const, tx: chain.explorerTx(cfg, hash) };
  }
  if (s === "reverted") {
    await db.from("stock_certificates").update({ status: "failed", tx_hash: null, error: "The transfer was reverted on-chain.", updated_at: done }).eq("id", c.id);
    throw new Error("The transfer didn't go through. Try again, or choose another wallet.");
  }
  return { state: "sending" as const, tx: chain.explorerTx(cfg, hash) };
}

/** Emails a fresh one-time claim link to the account email (older links stop working). */
async function emailClaimLink(c: StockRow, origin: string | null | undefined, actor: string | null) {
  const db = await admin();
  const { data: u } = await db.auth.admin.getUserById(c.user_id);
  const email = realEmail(u?.user?.email);
  if (!email) throw new Error("Your account has no email address we can send to. Choose a wallet instead.");
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const now = new Date().toISOString();
  const { data: ok } = await db
    .from("stock_certificates")
    .update({ status: "emailed", delivery: "email", email, claim_rand: rand, emailed_at: now, to_wallet: null, error: null, updated_at: now })
    .eq("id", c.id)
    .in("status", ["unclaimed", "emailed", "failed"])
    .select("id");
  if (!ok?.length) throw new Error("This certificate is already being sent, or was sent.");
  const { issueStockClaimCode } = await import("./wallet-proof.server");
  const { code, expiresAt } = await issueStockClaimCode(c.id, rand);
  const { data: prof } = await db.from("profiles").select("display_name").eq("id", c.user_id).maybeSingle();
  const { sendTemplateEmail } = await import("./email-templates/send-email");
  try {
    await sendTemplateEmail("stock-certificate-claim", email, {
      templateData: {
        prize: c.prize_name,
        username: prof?.display_name ?? "",
        tokenId: c.token_id ?? "",
        link: `${siteOrigin(origin)}/claim-stock?c=${encodeURIComponent(code)}`,
        expires: new Date(expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      },
      idempotencyKey: `stock-claim-${c.id}-${rand}`,
    });
  } catch (e) {
    await db.from("stock_certificates").update({ status: "failed", claim_rand: null, error: "The email couldn't be sent.", updated_at: new Date().toISOString() }).eq("id", c.id);
    throw new Error(`The email couldn't be sent (${(e as Error).message.slice(0, 80)}). Try again, or choose a wallet.`);
  }
  await audit(actor, "stock.emailed", { id: c.id, token_id: c.token_id });
  return { email: maskEmail(email) };
}

async function rowFor(id: string, userId?: string) {
  let q = (await admin()).from("stock_certificates").select("*").eq("id", id);
  if (userId) q = q.eq("user_id", userId);
  const { data } = await q.maybeSingle();
  return (data as StockRow | null) ?? null;
}

const FRIENDLY_STATUS = (r: StockRow) => (r.status === "failed" ? (r.error ?? "Sending failed. Try again.") : null);

// ---------- Players ----------

/** The signed-in player's stock certificates, their wallets, and whether the account email can be used. */
export const getMyStockCertificates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureStockCertificates(context.userId).catch(() => undefined);
    const db = await admin();
    const load = async () => {
      const { data, error } = await db.from("stock_certificates").select("*").eq("user_id", context.userId).order("created_at", { ascending: false });
      return error ? null : ((data ?? []) as StockRow[]);
    };
    let rows = await load();
    if (!rows) return { rows: [], wallets: [], email: null as string | null };
    if (await settleSending(rows)) rows = (await load()) ?? rows;
    if (!rows.length) return { rows: [], wallets: [], email: null as string | null };
    const { explorerTx, explorerToken } = await import("./stock-chain.server");
    const cfg = await stockConfig();
    const [{ data: wallets }, { data: u }] = await Promise.all([
      db.from("wallets").select("address, kind, is_default").eq("user_id", context.userId).order("is_default", { ascending: false }),
      db.auth.admin.getUserById(context.userId),
    ]);
    const email = realEmail(u?.user?.email);
    return {
      rows: rows.map((r) => ({
        id: r.id,
        spinId: r.spin_id,
        prize: r.prize_name,
        tokenId: r.token_id,
        status: r.status,
        delivery: r.delivery,
        toWallet: r.to_wallet,
        emailedTo: r.status === "emailed" && r.email ? maskEmail(r.email) : null,
        problem: FRIENDLY_STATUS(r),
        txUrl: explorerTx(cfg, r.tx_hash),
        tokenUrl: explorerToken(cfg, r.contract, r.token_id),
        chain: cfg.chain_name ?? "Robinhood Chain",
        wonAt: r.created_at,
      })),
      wallets: ((wallets ?? []) as { address: string; kind: string | null; is_default: boolean | null }[]).map((w) => ({
        address: String(w.address).toLowerCase(),
        kind: w.kind,
        isDefault: !!w.is_default,
      })),
      email: email ? maskEmail(email) : null,
    };
  });

/**
 * The winner's choice. "wallet": the app sends the certificate now to one of the player's linked wallets.
 * "email": a one-time claim link goes to the account email (choosing it again sends a fresh link).
 */
export const chooseStockDelivery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ id: z.string().uuid(), choice: z.enum(["wallet", "email"]), wallet: addr.optional(), origin: z.string().max(200).optional() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureStockCertificates(context.userId).catch(() => undefined);
    const c = await rowFor(data.id, context.userId);
    if (!c) throw new Error("That stock certificate isn't on your account.");
    if (c.status === "sent") throw new Error("This certificate was already sent.");
    if (c.status === "sending") throw new Error("This certificate is being sent right now.");
    if (data.choice === "email") {
      const r = await emailClaimLink(c, data.origin, context.userId);
      return { state: "emailed" as const, email: r.email, tx: null };
    }
    if (!data.wallet) throw new Error("Pick the wallet that should receive the certificate.");
    const { data: w } = await (await admin()).from("wallets").select("address").eq("user_id", context.userId).eq("address", data.wallet).maybeSingle();
    if (!w) throw new Error("Pick one of the wallets linked to your account.");
    const r = await deliver(c, data.wallet, "wallet", context.userId);
    return { ...r, email: null };
  });

// ---------- Email claim link (no sign-in: the link itself is the key) ----------

async function rowForCode(code: string) {
  const { readStockClaimCode } = await import("./wallet-proof.server");
  const { certId, rand } = await readStockClaimCode(code);
  await ensureStockCertificates().catch(() => undefined);
  const c = await rowFor(certId);
  if (!c) throw new Error("This claim link isn't valid.");
  return { c, live: !!c.claim_rand && c.claim_rand === rand };
}

/** What the claim link is for (prize, certificate number, and whether it can still be claimed). */
export const describeStockClaim = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ code: z.string().min(20).max(400) }).parse(d))
  .handler(async ({ data }) => {
    let { c, live } = await rowForCode(data.code);
    if (c.status === "sending" && (await settleSending([c]))) c = (await rowFor(c.id)) ?? c;
    const { explorerTx, explorerToken } = await import("./stock-chain.server");
    const cfg = await stockConfig();
    const base = { prize: c.prize_name, tokenId: c.token_id, chain: cfg.chain_name ?? "Robinhood Chain", tokenUrl: explorerToken(cfg, c.contract, c.token_id) };
    if (c.status === "sent" || c.status === "sending")
      return { ...base, state: c.status, toWallet: c.to_wallet, txUrl: explorerTx(cfg, c.tx_hash), problem: null };
    if (!live || c.delivery !== "email" || !["emailed", "failed"].includes(c.status))
      return { ...base, state: "replaced" as const, toWallet: null, txUrl: null, problem: null };
    return { ...base, state: "claimable" as const, toWallet: null, txUrl: null, problem: c.status === "failed" ? c.error : null };
  });

/** Claims the certificate from the emailed link: the app sends it to the wallet given here. */
export const claimStockWithCode = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ code: z.string().min(20).max(400), wallet: addr }).parse(d))
  .handler(async ({ data }) => {
    const { c, live } = await rowForCode(data.code);
    if (c.status === "sent") throw new Error("This certificate was already sent.");
    if (!live || c.delivery !== "email") throw new Error("This claim link was replaced by a newer one, or the certificate was claimed another way.");
    return deliver(c, data.wallet, "email", null);
  });

// ---------- Admins ----------

/** Everything for Admin → Stock certificates: settings, custody wallet, prizes with token IDs, and every win. */
export const adminStockOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    await ensureStockCertificates().catch(() => undefined);
    const db = await admin();
    const cfg = await stockConfig();
    const { data: prizes, error: pe } = await db.from("prizes").select("id, name, rarity, active, inventory, is_physical, cert_value_usd, stock_token_ids").order("created_at");
    const load = async () => {
      const { data, error } = await db.from("stock_certificates").select("*").order("created_at", { ascending: false }).limit(500);
      return error ? null : ((data ?? []) as StockRow[]);
    };
    let rows = await load();
    if (pe || !rows) return { ready: false as const };
    if (await settleSending(rows)) rows = (await load()) ?? rows;
    const chain = await import("./stock-chain.server");
    const allTokens = [...new Set(((prizes ?? []) as any[]).flatMap((p) => (p.stock_token_ids as string[] | null) ?? []))];
    const custody = await chain.custodyStatus(cfg, allTokens);
    const assigned = new Map(rows.filter((r) => r.token_id && r.contract === cfg.contract).map((r) => [r.token_id!, r]));
    const ids = [...new Set(rows.map((r) => r.user_id))];
    const { data: profs } = ids.length ? await db.from("profiles").select("id, display_name").in("id", ids) : { data: [] };
    const names = new Map(((profs ?? []) as { id: string; display_name: string | null }[]).map((p) => [p.id, p.display_name ?? "Player"]));
    return {
      ready: true as const,
      config: cfg,
      missing: chain.stockMissing(cfg),
      hasPrivateRpc: !!process.env["STOCK_RPC_URL"],
      custody,
      prizes: ((prizes ?? []) as any[]).map((p) => {
        const tokens = ((p.stock_token_ids as string[] | null) ?? []).map((t) => ({
          id: t,
          assigned: assigned.has(t),
          inCustody: custody.address && custody.owners[t] ? custody.owners[t] === custody.address : null,
        }));
        return {
          id: p.id as string,
          name: p.name as string,
          rarity: p.rarity as string,
          active: !!p.active,
          inventory: (p.inventory as number | null) ?? null,
          other: p.is_physical ? "IRL prize" : p.cert_value_usd != null ? "Gift certificate" : null,
          tokens,
          free: tokens.filter((t) => !t.assigned).length,
        };
      }),
      rows: rows.map((r) => ({
        id: r.id,
        prize: r.prize_name,
        player: names.get(r.user_id) ?? "Player",
        tokenId: r.token_id,
        stale: !!(r.contract && cfg.contract && r.contract !== cfg.contract),
        status: r.status,
        delivery: r.delivery,
        toWallet: r.to_wallet,
        email: r.email ? maskEmail(r.email) : null,
        error: r.error,
        txUrl: chain.explorerTx(cfg, r.tx_hash),
        wonAt: r.created_at,
        sentAt: r.sent_at,
      })),
    };
  });

/** Chain, RPC, explorer and certificate contract (super admin). */
export const adminSetStockConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        chain_id: z.number().int().positive().nullable(),
        chain_name: z.string().trim().max(60).nullable(),
        rpc_url: z.string().trim().url().max(300).nullable(),
        explorer_url: z.string().trim().url().max(300).nullable(),
        contract: addr.nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertSuper(context);
    if (data.rpc_url && !/^https:\/\//.test(data.rpc_url)) throw new Error("The RPC URL must start with https://");
    const db = await admin();
    const { error } = await db.from("app_config").upsert({ key: "stock", value: data, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw new Error(error.message);
    await audit(context.userId, "stock.config", data);
    return { ok: true };
  });

/** The certificate token IDs set aside for a prize (empty list = a normal prize again). */
export const adminSetStockPrize = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ prizeId: z.string().uuid(), tokenIds: z.array(z.string().trim().regex(/^[0-9]{1,78}$/, "Token IDs are whole numbers")).max(1000) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    const tokens = [...new Set(data.tokenIds.map((t) => t.replace(/^0+(?=\d)/, "")))];
    // A token can belong to one prize only.
    const { data: others } = await db.from("prizes").select("id, name, stock_token_ids").neq("id", data.prizeId).not("stock_token_ids", "is", null);
    for (const p of (others ?? []) as { name: string; stock_token_ids: string[] }[]) {
      const dup = tokens.find((t) => p.stock_token_ids?.includes(t));
      if (dup) throw new Error(`Certificate #${dup} is already set aside for "${p.name}".`);
    }
    const { error } = await db.from("prizes").update({ stock_token_ids: tokens.length ? tokens : null }).eq("id", data.prizeId);
    if (error) throw new Error(/stock_token_ids/.test(error.message) ? "Stock certificates turn on after the database update (0020)." : error.message);
    await audit(context.userId, "stock.prize_set", { prize_id: data.prizeId, tokens: tokens.length });
    await ensureStockCertificates().catch(() => undefined);
    return { ok: true, count: tokens.length };
  });

/**
 * Try again for a failed or stuck certificate: re-send to the wallet the winner chose, or email a fresh claim link.
 * `newToken` first gives the win another free certificate of its prize (e.g. the old one isn't in custody).
 */
export const adminRetryStock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), newToken: z.boolean().default(false), origin: z.string().max(200).optional() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    let c = await rowFor(data.id);
    if (!c) throw new Error("Certificate not found.");
    if (c.status === "sent") throw new Error("This certificate was already sent.");
    if (c.status === "sending") {
      await settleSending([c]);
      return { state: "checked" as const };
    }
    if (data.newToken) {
      await db.from("stock_certificates").update({ token_id: null, contract: null, updated_at: new Date().toISOString() }).eq("id", c.id).in("status", ["unclaimed", "emailed", "failed"]);
      await audit(context.userId, "stock.new_token", { id: c.id, old_token: c.token_id });
      await ensureStockCertificates();
      c = await rowFor(data.id);
      if (!c?.token_id) throw new Error("No free certificate left for this prize. Add token IDs to the prize first.");
      if (c.delivery == null) return { state: "token" as const };
    }
    if (c.delivery === "wallet" && c.to_wallet) {
      const r = await deliver(c, c.to_wallet, "wallet", context.userId);
      return { state: r.state };
    }
    if (c.delivery === "email") {
      await emailClaimLink(c, data.origin, context.userId);
      return { state: "emailed" as const };
    }
    throw new Error("The winner hasn't chosen how to receive it yet.");
  });
