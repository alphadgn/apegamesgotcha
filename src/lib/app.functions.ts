import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // The generated database types can briefly lag behind applied migrations.
  return supabaseAdmin as any;
}

async function getConfig(key: string) {
  const db = await admin();
  const { data, error } = await db.from("app_config").select("value").eq("key", key).single();
  if (error) throw new Error(`Missing config: ${key}`);
  return data.value as any;
}

async function audit(actor: string, action: string, details: unknown) {
  const db = await admin();
  await db.from("audit_log").insert({ actor, action, details: details as any });
}

async function assertAdmin(ctx: { userId: string }) {
  const h = await import("./helpers.server");
  await h.assertAdmin(ctx.userId); // server-side role check with the service role, never the client
}

// Wallet linking (SIWE), NFT sync/burns and draws live in identity.functions.ts, nft.functions.ts
// and draws.functions.ts.

// ---------- Admin ----------
export const adminUpdateConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ key: z.string().min(1), value: z.record(z.any()) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { error } = await db.from("app_config").upsert({ key: data.key, value: data.value, updated_by: context.userId });
    if (error) throw new Error(error.message);
    await audit(context.userId, "config.updated", data);
    return { ok: true };
  });

// adminSavePrize / adminGrant: see economics.functions.ts

export const adminSetLevel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ tokenId: z.string().regex(/^\d+$/), level: z.number().int().min(0).max(100).nullable() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { data: ex } = await db.from("nft_holdings").select("token_id").eq("token_id", data.tokenId).maybeSingle();
    if (!ex) throw new Error("Token not synced yet");
    await db.from("nft_holdings").update({ level_override: data.level }).eq("token_id", data.tokenId);
    await audit(context.userId, "nft.level_override", data);
    return { ok: true };
  });

// Chainlink VRF admin: see draws.functions.ts

// ---------- Spin purchases (APE on ApeChain) ----------
export const getPurchaseSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const cfg = await getConfig("purchase") as import("./purchase.server").PurchaseConfig;
    return { enabled: cfg.enabled, chain_id: cfg.chain_id, rpc_url: cfg.rpc_url, explorer_url: cfg.explorer_url,
      treasury: cfg.treasury, price_ape_per_spin: cfg.price_ape_per_spin ?? "", price_usd_per_spin: cfg.price_usd_per_spin,
      bundles: cfg.bundles, privy_app_id: cfg.privy_app_id };
  });

export const getSpinPriceQuote = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const p = await import("./purchase.server");
    return p.quoteSpinPrice(await getConfig("purchase"));
  });

// The player picks a bundle (5, 10, 15 or 20 spins); we lock the price in a purchase row and the
// wallet sends that exact APE amount to the treasury with the purchase id as calldata.
export const createSpinPurchase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ quantity: z.number().int() }).parse(d))
  .handler(async ({ data, context }) => {
    const p = await import("./purchase.server");
    const cfg = p.requirePurchasing((await getConfig("purchase")) as import("./purchase.server").PurchaseConfig);
    const bundles = cfg.bundles?.length ? cfg.bundles : p.DEFAULT_BUNDLES;
    if (!bundles.includes(data.quantity) || data.quantity % 5 !== 0 || data.quantity > 20) throw new Error("Choose 5, 10, 15 or 20 spins.");
    const vrf = await getConfig("vrf");
    if (!vrf.enabled || !/^0x[0-9a-fA-F]{40}$/.test(vrf.contract ?? "")) throw new Error("Purchases will open when the real prize draw is ready.");
    const db = await admin();
    // Economic controls: costs verified, prize reserve covers every remaining real prize.
    const { data: econ, error: econErr } = await db.rpc("economics_status");
    if (econErr) throw new Error(econErr.message);
    if (!econ?.purchases_allowed) throw new Error("Spin purchases are paused while prize funding is being confirmed.");
    const quote = await p.quoteSpinPrice(cfg);
    const price = BigInt(quote.eachWei) * BigInt(data.quantity);
    const quotedUsd = cfg.price_usd_per_spin ? (Number(cfg.price_usd_per_spin) * data.quantity).toFixed(2) : null;
    const { data: row, error } = await db
      .from("spin_purchases")
      .insert({ user_id: context.userId, quantity: data.quantity, price_wei: price.toString(), chain_id: cfg.chain_id, treasury: cfg.treasury.toLowerCase(), quoted_usd: quotedUsd })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await audit(context.userId, "purchase.created", { id: row.id, quantity: data.quantity, price_wei: price.toString() });
    return {
      purchaseId: row.id as string,
      chainId: cfg.chain_id,
      to: cfg.treasury,
      valueWei: price.toString(),
      data: p.purchaseData(row.id),
      explorerUrl: cfg.explorer_url ?? null,
    };
  });

export const confirmSpinPurchase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ purchaseId: z.string().uuid(), txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) }).parse(d))
  .handler(async ({ data, context }) => {
    const p = await import("./purchase.server");
    const cfg = (await getConfig("purchase")) as import("./purchase.server").PurchaseConfig;
    const db = await admin();
    const { data: row } = await db.from("spin_purchases").select("*").eq("id", data.purchaseId).eq("user_id", context.userId).maybeSingle();
    if (!row) throw new Error("Purchase not found");
    if (row.status === "paid") return { status: "paid" as const, quantity: row.quantity as number };
    const check = await p.checkPayment(
      { ...cfg, chain_id: row.chain_id, treasury: row.treasury }, // verify against the terms locked at purchase time
      data.txHash as `0x${string}`,
      row.id,
      BigInt(row.price_wei),
    );
    if (check.state === "pending") return { status: "pending" as const, quantity: row.quantity as number };
    if (check.state === "invalid") throw new Error(check.reason);
    const { error } = await db.rpc("complete_spin_purchase", { _purchase_id: row.id, _tx_hash: data.txHash, _payer: check.payer });
    if (error) throw new Error(error.message);
    await audit(context.userId, "purchase.paid", { id: row.id, tx: data.txHash, quantity: row.quantity });
    return { status: "paid" as const, quantity: row.quantity as number };
  });

// ---------- Admin: setup checklist ----------
// Reports which settings/keys are in place. Never returns secret values — only whether they're set.
type SetupItem = { group: string; label: string; ok: boolean; optional?: boolean; detail: string; where: string };

export const adminSetupStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const db = await admin();
    const items: SetupItem[] = [];
    const isAddr = (a: unknown) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
    const cfg = async (key: string) => (await db.from("app_config").select("value").eq("key", key).maybeSingle()).data?.value ?? null;

    // Database
    const purchasesTable = await db.from("spin_purchases").select("id", { head: true, count: "exact" });
    const spinsStatus = await db.from("spins").select("status", { head: true, count: "exact" });
    items.push({ group: "Database", label: "Migrations applied (Chainlink draws + purchases)", ok: !purchasesTable.error && !spinsStatus.error, detail: purchasesTable.error?.message ?? spinsStatus.error?.message ?? "Tables are in place", where: "Lovable: apply pending Supabase migrations" });

    // Chainlink VRF draw
    const vrf = (await cfg("vrf")) as { enabled?: boolean; contract?: string; rpc_url?: string; chain_id?: number; coordinator?: string } | null;
    const key = process.env["VRF_OPERATOR_PRIVATE_KEY"];
    const keyOk = !!key && /^0x[0-9a-fA-F]{64}$/.test(key);
    items.push({ group: "Chainlink draw (Base)", label: "Draw contract address", ok: isAddr(vrf?.contract), detail: isAddr(vrf?.contract) ? vrf!.contract! : "Not set — deploy contracts/ (see contracts/README.md)", where: "Admin → Configuration → vrf → contract" });
    items.push({ group: "Chainlink draw (Base)", label: "Operator wallet key (secret)", ok: keyOk, detail: keyOk ? "Set" : key ? "Set, but not a 0x + 64 hex character private key" : "Not set", where: "Lovable → Cloud → Secrets → VRF_OPERATOR_PRIVATE_KEY" });
    if (keyOk && isAddr(vrf?.contract) && vrf?.rpc_url) {
      try {
        const { privateKeyToAccount } = await import("viem/accounts");
        const { createPublicClient, http, parseAbi } = await import("viem");
        const me = privateKeyToAccount(key as `0x${string}`).address;
        const pub = createPublicClient({ transport: http(vrf.rpc_url) });
        const op = await pub.readContract({ address: vrf.contract as `0x${string}`, abi: parseAbi(["function operator() view returns (address)"]), functionName: "operator" });
        const bal = await pub.getBalance({ address: me });
        items.push({ group: "Chainlink draw (Base)", label: "Operator key matches the contract", ok: op.toLowerCase() === me.toLowerCase(), detail: op.toLowerCase() === me.toLowerCase() ? `Operator ${me}` : `Contract operator is ${op}, key is for ${me}`, where: "Use the key for the OPERATOR you deployed with" });
        items.push({ group: "Chainlink draw (Base)", label: "Operator wallet has ETH for gas", ok: bal > 0n, detail: `${Number(bal) / 1e18} ETH`, where: `Send a little ETH (Base) to ${me}` });
      } catch (e) {
        items.push({ group: "Chainlink draw (Base)", label: "Contract reachable", ok: false, detail: (e as Error).message.slice(0, 160), where: "Check vrf.rpc_url and vrf.contract" });
      }
    }
    if (isAddr(vrf?.contract)) {
      try {
        const v = await import("./vrf.server");
        const { data: prizes } = await db.from("prizes").select("id, weight, inventory, active, onchain_index");
        const chain = await v.readPool(vrf as import("./vrf.server").VrfConfig);
        const ok = v.weightsMatch(v.poolArrays(prizes ?? []), chain.pool) && chain.pool.length > 0;
        items.push({ group: "Chainlink draw (Base)", label: "Prize odds published on-chain", ok, detail: ok ? `Pool v${chain.version}` : "Odds differ from the contract (or never published)", where: "Admin → Chainlink VRF → Publish prize pool" });
      } catch {
        /* covered by "Contract reachable" */
      }
    }
    items.push({ group: "Chainlink draw (Base)", label: "Real spins switched on", ok: !!vrf?.enabled, detail: vrf?.enabled ? "On" : "Off — players see “Spins open soon”", where: "Admin → Configuration → vrf → enabled: true (last step)" });

    // Purchases
    const pc = (await cfg("purchase")) as { enabled?: boolean; treasury?: string; price_ape_per_spin?: string; price_usd_per_spin?: string; privy_app_id?: string } | null;
    const price = Number(pc?.price_usd_per_spin ?? pc?.price_ape_per_spin ?? 0);
    items.push({ group: "Spin purchases (APE on ApeChain)", label: "Treasury wallet (receives APE)", ok: isAddr(pc?.treasury), detail: pc?.treasury && isAddr(pc.treasury) ? pc.treasury : "Not set — use a regular wallet address, not a Safe/contract", where: "Admin → Configuration → purchase → treasury" });
    items.push({ group: "Spin purchases (APE on ApeChain)", label: "Price per spin", ok: price > 0, detail: price > 0 ? (pc?.price_usd_per_spin ? `$${price} USD in APE per spin` : `${price} APE per spin`) : "Not set", where: "Admin → Configuration → purchase → price_usd_per_spin" });
    items.push({ group: "Sign-in (Privy)", label: "Privy App ID", ok: !!pc?.privy_app_id, detail: pc?.privy_app_id ? "Set" : "Not set — sign-in falls back to email/password and only browser-extension wallets can pay", where: "dashboard.privy.io → App settings → App ID → Admin → Configuration → purchase → privy_app_id. In Privy also: add your published + preview domains under Allowed origins; turn on Email, Google and Wallet login; turn on Ethereum embedded wallets" });
    const privySecret = !!process.env["PRIVY_APP_SECRET"];
    const firecrawl = !!process.env["FIRECRAWL_API_KEY"];
    const { data: ekRows } = await db.from("event_knowledge").select("fetched_at").order("fetched_at", { ascending: false }).limit(1);
    const lastFetch = (ekRows?.[0]?.fetched_at as string | undefined) ?? null;
    items.push({ group: "Guide: ApeFest 2026 info", label: "Firecrawl API key (secret)", ok: firecrawl, detail: firecrawl ? `Set${lastFetch ? ` · BAYC pages last fetched ${new Date(lastFetch).toLocaleString("en-US", { timeZone: "America/New_York" })} ET` : " · not fetched yet (use “Refresh ApeFest info” below)"}` : "Not set — the guide only knows the basic event facts", where: "Lovable → Connectors → Firecrawl (sets FIRECRAWL_API_KEY), or firecrawl.dev → API keys → Lovable → Cloud → Secrets → FIRECRAWL_API_KEY" });
    items.push({ group: "Sign-in (Privy)", label: "Privy App Secret (secret)", ok: privySecret, detail: privySecret ? "Set" : "Not set — Privy sign-in can't finish without it", where: "dashboard.privy.io → App settings → API keys → App secret → Lovable → Cloud → Secrets → PRIVY_APP_SECRET" });
    // Seasons & leaderboard
    const seasonsTable = await db.from("seasons").select("id, slug, status, is_legacy, ends_at, settlement_deadline");
    items.push({ group: "Seasons & leaderboard", label: "Season migrations applied", ok: !seasonsTable.error, detail: seasonsTable.error?.message ?? "seasons, ledger, standings in place", where: "Lovable: apply pending Supabase migrations (20261009100000…100500)" });
    const live = ((seasonsTable.data ?? []) as { slug: string; status: string; is_legacy: boolean }[]).find((x) => x.status === "active" && !x.is_legacy);
    items.push({ group: "Seasons & leaderboard", label: "A season is active", ok: !!live, optional: true, detail: live ? live.slug : "No active season — draws still deliver prizes but earn no seasonal points", where: "Admin → Seasons: create a draft with real UTC dates, then Activate (rules freeze)" });
    const { data: cols } = await db.from("nft_collections").select("label, status, chain_id, snapshot_block");
    const readyCols = ((cols ?? []) as { status: string }[]).filter((c) => c.status === "ready").length;
    items.push({ group: "Seasons & leaderboard", label: "2025 NFT collection confirmed + snapshot ready", ok: readyCols > 0, optional: true, detail: readyCols ? `${readyCols} ready` : "Only the CANDIDATE ApeChain contract is listed — confirm it, set deploy/snapshot block + hash, index, then mark ready", where: "Admin → Snapshot" });
    const snapCfg = (await cfg("snapshot")) as { archive_rpc_urls?: Record<string, string> } | null;
    items.push({ group: "Seasons & leaderboard", label: "Archive RPC for snapshot verification", ok: Object.keys(snapCfg?.archive_rpc_urls ?? {}).length > 0, optional: true, detail: Object.keys(snapCfg?.archive_rpc_urls ?? {}).join(", ") || "Not set — snapshot claims stay pending", where: "Admin → Configuration → snapshot.archive_rpc_urls {\"33139\": \"https://…archive…\"}" });
    const { data: econ } = await db.rpc("economics_status");
    items.push({ group: "Economic controls", label: "Prize pool classified and costed", ok: (econ?.prize_issues ?? []).length === 0, detail: (econ?.prize_issues ?? []).map((i: { prize: string; issue: string }) => `${i.prize}: ${i.issue}`).join(" · ") || "OK", where: "Admin → Economics → Prizes" });
    items.push({ group: "Economic controls", label: "Draw costs verified (VRF, gas, provider)", ok: !!econ?.cost_estimate?.verified, detail: econ?.cost_estimate?.verified ? `Expected $${econ.cost_estimate.expected_cost_per_spin_usd}/spin, worst case $${econ.cost_estimate.worst_case_cost_per_spin_usd}` : `Unverified: ${(econ?.cost_estimate?.unverified ?? []).join(", ")}`, where: "Admin → Economics → Operating costs" });
    items.push({ group: "Economic controls", label: "Purchases funded (prize reserve covers real prizes)", ok: !!econ?.purchases_allowed, detail: econ?.purchases_allowed ? "OK" : (econ?.purchase_blockers ?? []).join(" · "), where: "Admin → Economics → Funding" });
    for (const [src, b] of Object.entries((econ?.sponsored_budgets ?? {}) as Record<string, { paused: boolean; available_usd: string; pause_reason: string | null }>)) {
      items.push({ group: "Economic controls", label: `Sponsored ${src.replace("_", " ")} spins funded`, ok: !b.paused, optional: true, detail: b.paused ? `Paused: ${b.pause_reason ?? ""}` : `$${b.available_usd} available`, where: "Admin → Economics → Budgets" });
    }
    const siwe = (await cfg("siwe")) as { allowed_origins?: string[] } | null;
    items.push({ group: "Identity", label: "Wallet signature origins (SIWE)", ok: (siwe?.allowed_origins ?? []).length > 0, detail: (siwe?.allowed_origins ?? []).join(", ") || "Not set — wallet linking by signature is disabled", where: "Admin → Configuration → siwe.allowed_origins [\"https://your-published-domain\"]" });
    const social = (await cfg("social")) as { verification?: string } | null;
    const xMode = social?.verification === "x_api" && process.env["X_BEARER_TOKEN"] ? "x_api" : social?.verification === "manual" || social?.verification === "x_api" ? "manual" : "disabled";
    items.push({ group: "Identity", label: "X share verification", ok: xMode !== "disabled", optional: true, detail: xMode === "disabled" ? "Disabled — the +2 share reward is hidden" : xMode === "x_api" ? "X API (X_BEARER_TOKEN set)" : "Manual review queue (Admin → Shares)", where: "Admin → Configuration → social.verification = manual | x_api (+ secret X_BEARER_TOKEN)" });
    const { data: coordRow } = await db.from("draw_coordination").select("worker_last_run_at, requests_paused, pause_reason").eq("id", true).maybeSingle();
    const lastRun = coordRow?.worker_last_run_at ? Date.parse(coordRow.worker_last_run_at) : 0;
    items.push({ group: "Chainlink draw (Base)", label: "Settlement worker running", ok: Date.now() - lastRun < 10 * 60_000, detail: lastRun ? `Last run ${new Date(lastRun).toISOString()}` : "Never ran — schedule POST /api/worker/settle every minute", where: "Lovable → Cron: POST /api/worker/settle with Authorization: Bearer $LOVABLE_CRON_SECRET" });
    items.push({ group: "Chainlink draw (Base)", label: "Expected VRF coordinator recorded", ok: isAddr(vrf?.coordinator), optional: true, detail: isAddr(vrf?.coordinator) ? vrf!.coordinator! : "Not set — coordinator changes can't be detected", where: "Admin → Configuration → vrf.coordinator" });
    if (coordRow?.requests_paused) items.push({ group: "Chainlink draw (Base)", label: "Draws not paused", ok: false, detail: coordRow.pause_reason ?? "Paused", where: "Admin → Settlement → Resume (after resolving the alert)" });
    items.push({ group: "Spin purchases (APE on ApeChain)", label: "Purchases switched on", ok: !!pc?.enabled, detail: pc?.enabled ? "On" : "Off — Refill shows “purchases open soon”", where: "Admin → Configuration → purchase → enabled: true (last step)" });
    return items;
  });

// ---------- Privy sign-in & default wallet ----------
// Privy is the sign-in window (email, Google or wallet) and creates an embedded wallet for players who
// don't have one. The server verifies the Privy session, maps it to a Supabase account (same Privy login,
// same verified email, or same linked wallet) and hands back a one-time token the browser swaps for a
// normal Supabase session. Supabase stays the source of truth for the app; Privy is the front door.

/** Public, non-secret bits the sign-in window needs before anyone is signed in. */
export const getPrivyPublicConfig = createServerFn({ method: "GET" }).handler(async () => {
  const cfg = (await getConfig("purchase").catch(() => null)) as import("./purchase.server").PurchaseConfig | null;
  return {
    privy_app_id: cfg?.privy_app_id?.trim() || null,
    chain_id: cfg?.chain_id ?? 33139,
    rpc_url: cfg?.rpc_url ?? "https://rpc.apechain.com/http",
    explorer_url: cfg?.explorer_url ?? null,
  };
});

async function privyIdentityFromToken(accessToken: string) {
  const cfg = (await getConfig("purchase").catch(() => null)) as import("./purchase.server").PurchaseConfig | null;
  const appId = cfg?.privy_app_id?.trim();
  if (!appId) throw new Error("Privy sign-in isn't set up yet.");
  const privy = await import("./privy.server");
  const did = await privy.verifyPrivyAccessToken(accessToken, appId);
  return privy.fetchPrivyIdentity(did, appId);
}

/** Adds the player's Privy wallets to their account and makes sure they have a default wallet. */
async function syncPrivyWallets(userId: string, identity: import("./privy.server").PrivyIdentity) {
  const h = await import("./helpers.server");
  const skipped: string[] = [];
  // Privy verified these wallets (embedded wallet or Privy's own signature). The embedded wallet goes
  // first so it becomes the default for players without one. Never moves a wallet between accounts.
  const ordered = [...identity.wallets].sort((a, b) => (a.kind === "privy" ? -1 : 0) - (b.kind === "privy" ? -1 : 0));
  for (const w of ordered) {
    try {
      await h.rpc("link_verified_wallet", { _user: userId, _address: w.address, _kind: w.kind, _method: "privy", _chain_id: null, _is_contract: false });
    } catch (e) {
      if (/another account/.test((e as Error).message)) skipped.push(w.address);
      else throw e;
    }
  }
  return { skipped };
}

export const privySignIn = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ accessToken: z.string().min(20).max(4096) }).parse(d))
  .handler(async ({ data }) => {
    const identity = await privyIdentityFromToken(data.accessToken);
    const db = await admin();

    // 1) Same Privy login as before  2) same verified email  3) a wallet already linked to an account.
    let userId: string | null = ((await db.from("privy_accounts").select("user_id").eq("privy_did", identity.did).maybeSingle()).data?.user_id as string | undefined) ?? null;
    if (!userId && identity.email) {
      const { data: id } = await db.rpc("user_id_by_email", { _email: identity.email });
      userId = (id as string | null) ?? null;
    }
    if (!userId && identity.wallets.length) {
      const { data: w } = await db.from("wallets").select("user_id").in("address", identity.wallets.map((x) => x.address)).limit(1).maybeSingle();
      userId = (w?.user_id as string | undefined) ?? null;
    }

    let email: string | null = null;
    if (userId) {
      const { data: u } = await db.auth.admin.getUserById(userId);
      email = u?.user?.email ?? null;
      if (!email) {
        email = identity.email ?? `wallet-${identity.did.replace("did:privy:", "")}@privy.apegamesgotcha.app`;
        await db.auth.admin.updateUserById(userId, { email, email_confirm: true });
      }
    } else {
      // New player. Wallet-only sign-ins get a placeholder address; no email is ever sent to it.
      email = identity.email ?? `wallet-${identity.did.replace("did:privy:", "")}@privy.apegamesgotcha.app`;
      const { data: created, error } = await db.auth.admin.createUser({ email, email_confirm: true, user_metadata: { privy_did: identity.did } });
      if (error || !created?.user) throw new Error(error?.message ?? "Couldn't create your account");
      userId = created.user.id as string;
      await audit(userId, "user.created", { via: "privy" });
    }

    await db.from("privy_accounts").upsert({ privy_did: identity.did, user_id: userId }, { onConflict: "privy_did" });
    await syncPrivyWallets(userId!, identity);

    const { data: link, error: linkError } = await db.auth.admin.generateLink({ type: "magiclink", email });
    const tokenHash = link?.properties?.hashed_token as string | undefined;
    if (linkError || !tokenHash) throw new Error(linkError?.message ?? "Couldn't start your session");
    await audit(userId!, "user.signed_in", { via: "privy" });
    return { tokenHash };
  });

/** A signed-in player who also signs in to Privy (e.g. to pay): attach that Privy login and its wallets. */
export const linkPrivyAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ accessToken: z.string().min(20).max(4096) }).parse(d))
  .handler(async ({ data, context }) => {
    const identity = await privyIdentityFromToken(data.accessToken);
    const db = await admin();
    const { data: row } = await db.from("privy_accounts").select("user_id").eq("privy_did", identity.did).maybeSingle();
    if (row && row.user_id !== context.userId) throw new Error("That Privy login belongs to another player. Sign out and sign in with it instead.");
    if (!row) await db.from("privy_accounts").insert({ privy_did: identity.did, user_id: context.userId });
    const { skipped } = await syncPrivyWallets(context.userId, identity);
    return { skipped };
  });

/** Account preferences: choose which linked wallet is the default (used to pay for spins). */
export const setDefaultWallet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/) }).parse(d))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const address = data.address.toLowerCase();
    const { data: w } = await db.from("wallets").select("id").eq("user_id", context.userId).eq("address", address).maybeSingle();
    if (!w) throw new Error("That wallet isn't linked to your account");
    await db.from("wallets").update({ is_default: false }).eq("user_id", context.userId).eq("is_default", true);
    const { error } = await db.from("wallets").update({ is_default: true }).eq("id", w.id);
    if (error) throw new Error(error.message);
    await audit(context.userId, "wallet.default", { address });
    return { address };
  });

// ---------- Guide: ApeFest 2026 info (Firecrawl) ----------
export const adminRefreshEventInfo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const ek = await import("./event-knowledge.server");
    if (!ek.firecrawlConfigured()) throw new Error("Add the FIRECRAWL_API_KEY secret first.");
    const db = await admin();
    const cfg = ek.eventConfig(await getConfig("event_info").catch(() => null));
    const r = await ek.refreshEventKnowledge(db, cfg);
    await audit(context.userId, "event_info.refreshed", r);
    const { data } = await db.from("event_knowledge").select("url, title, source, fetched_at").order("fetched_at", { ascending: false });
    return { ...r, pages: (data ?? []) as { url: string; title: string | null; source: string; fetched_at: string }[] };
  });

export const adminEventInfoPages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const db = await admin();
    const { data } = await db.from("event_knowledge").select("url, title, source, fetched_at").order("fetched_at", { ascending: false });
    return (data ?? []) as { url: string; title: string | null; source: string; fetched_at: string }[];
  });
