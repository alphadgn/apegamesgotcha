import { createAnthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  createLovableAiGatewayRunIdFetch,
  getLovableAiGatewayRunId,
  withLovableAiGatewayRunIdHeader,
} from "./run-id";

const MODEL = "anthropic/claude-haiku-4-5";
const GATEWAY = "https://ai.gateway.lovable.dev/v1";

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

function authedClient(token: string) {
  const url = process.env["SUPABASE_URL"]!;
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient<Database>(url, key, {
    global: {
      fetch: (input, init) => {
        const headers = new Headers(
          typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
        );
        if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
        if (isNewSupabaseApiKey(key) && headers.get("Authorization") === `Bearer ${key}`) {
          headers.delete("Authorization");
        }
        headers.set("apikey", key);
        return fetch(input, { ...init, headers });
      },
      headers: { Authorization: `Bearer ${token}` },
    },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
}

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleGuideChat(request: Request): Promise<Response> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  // Signed-in players get personalized answers; signed-out visitors get a
  // public guide with general info only (no personal data, nothing persisted).
  let authed: { supabase: ReturnType<typeof authedClient>; userId: string } | null = null;
  if (token) {
    if (token.split(".").length !== 3) return jsonError(401, "Sign in to chat with the guide.");
    const supabase = authedClient(token);
    const { data: claims, error: authError } = await supabase.auth.getClaims(token);
    if (authError || !claims?.claims?.sub) return jsonError(401, "Sign in to chat with the guide.");
    authed = { supabase, userId: claims.claims.sub as string };
  }

  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) return jsonError(500, "The guide is not configured yet.");

  let body: { messages?: UIMessage[] };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid request body.");
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return jsonError(400, "No messages provided.");
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return jsonError(400, "Last message must be from the user.");

  // Live context for the guide: general rules for everyone, plus this player's
  // real numbers only when a verified session is present.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  type Prize = { name: string; rarity: string; points: number };
  type Cfg = {
    scoring?: { level_weights?: Record<string, number>; default_level_weight?: number };
    spins?: { daily_limit?: number; campaign_limit?: number };
    purchase?: { enabled?: boolean; price_ape_per_spin?: string; price_usd_per_spin?: string; bundles?: number[] };
  };

  let prizes: Prize[] = [];
  let nft: { burn_min_level?: number; opensea_url?: string } = {};
  let byReason: Record<string, number> = {};
  let total = 0;
  let rankRow: { rank: number } | undefined;
  let spinsReady = 0;
  let cfg: Cfg = {};

  if (authed) {
    const [prizesRes, nftRes, ledgerRes, creditsRes, boardRes, cfgRes] = await Promise.all([
      authed.supabase.from("prizes").select("name, rarity, points").eq("active", true),
      authed.supabase.from("app_config").select("value").eq("key", "nft").maybeSingle(),
      authed.supabase.from("points_ledger").select("amount, reason").eq("user_id", authed.userId),
      authed.supabase.from("spin_credits").select("id", { count: "exact", head: true }).eq("user_id", authed.userId).is("used_spin_id", null),
      authed.supabase.rpc("get_leaderboard", { _limit: 500 }),
      // Non-sensitive rule values only (scoring weights, spin limits, prices).
      supabaseAdmin.from("app_config").select("key, value").in("key", ["scoring", "spins", "purchase"]),
    ]);
    prizes = (prizesRes.data ?? []) as Prize[];
    nft = (nftRes.data?.value ?? {}) as { burn_min_level?: number; opensea_url?: string };
    const ledger = (ledgerRes.data ?? []) as { amount: number; reason: string }[];
    for (const l of ledger) byReason[l.reason] = (byReason[l.reason] ?? 0) + l.amount;
    total = ledger.reduce((s, l) => s + l.amount, 0);
    rankRow = ((boardRes.data ?? []) as { rank: number; user_id: string }[]).find((r) => r.user_id === authed!.userId);
    cfg = Object.fromEntries(((cfgRes.data ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value])) as Cfg;
    spinsReady = creditsRes.count ?? 0;
  } else {
    const [prizesRes, nftRes, cfgRes] = await Promise.all([
      supabaseAdmin.from("prizes").select("name, rarity, points").eq("active", true),
      supabaseAdmin.from("app_config").select("value").eq("key", "nft").maybeSingle(),
      supabaseAdmin.from("app_config").select("key, value").in("key", ["scoring", "spins", "purchase"]),
    ]);
    prizes = (prizesRes.data ?? []) as Prize[];
    nft = (nftRes.data?.value ?? {}) as { burn_min_level?: number; opensea_url?: string };
    cfg = Object.fromEntries(((cfgRes.data ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value])) as Cfg;
  }
  const weights = cfg.scoring?.level_weights ?? {};
  const reasonLabel: Record<string, string> = { holding: "holding NFTs", spin: "gacha prizes", admin_adjustment: "organizer grants" };

  const system = [
    "You are the ApeGames Gotcha guide — a friendly, energetic arcade host for the Go ApeGames 2026 pre-event gacha.",
    "Answer questions about how the app works: linking an ApeChain wallet, earning holding points from ApeGames NFTs, spinning the gotcha machine, prizes and rarity, the leaderboard, and the Charleston event.",
    `Burning an NFT of Level ${nft.burn_min_level ?? 4} or higher grants a free spin. The NFT collection is on ApeChain${nft.opensea_url ? ` (OpenSea: ${nft.opensea_url})` : ""}.`,
    prizes.length
      ? `Current prizes: ${prizes.map((p) => `${p.name} (${p.rarity}, ${p.points} pts)`).join("; ")}.`
      : "Prizes are being configured.",
    "HOW POINTS WORK (real rules from the live settings):",
    `- Holding: linking a wallet and syncing NFTs awards points once per NFT by level: ${Object.entries(weights).map(([lv, p]) => `Level ${lv} = ${p} pts`).join(", ") || "set by organizers"}${cfg.scoring?.default_level_weight != null ? ` (unknown level = ${cfg.scoring.default_level_weight} pts)` : ""}.`,
    "- Spins: every prize won adds its point value instantly.",
    "- Organizer grants: admins can add or adjust points.",
    "- Spending: points are not spent or deducted; they only accumulate and decide leaderboard rank going into Charleston. Spins are bought with APE or earned by burning, never with points.",
    cfg.spins ? `- Spin limits: ${cfg.spins.daily_limit ?? "no"} per day, ${cfg.spins.campaign_limit ?? "no"} per campaign.` : "",
    cfg.purchase?.enabled
      ? `- Refill: ${cfg.purchase.price_usd_per_spin ? `$${cfg.purchase.price_usd_per_spin} USD worth of APE` : `${cfg.purchase.price_ape_per_spin} APE`} per spin on ApeChain, bundles of ${(cfg.purchase.bundles ?? [5, 10, 15, 20]).join("/")}. The APE amount uses a live exchange quote; network fees are extra.`
      : `- Buying spins is not open yet.${cfg.purchase?.price_usd_per_spin ? ` Planned price: $${cfg.purchase.price_usd_per_spin} USD worth of APE per spin on ApeChain.` : ""}`,
    authed ? "THIS PLAYER RIGHT NOW:" : "This visitor is not signed in.",
    ...(authed
      ? [
          `- Total points: ${total}${rankRow ? `, leaderboard rank #${rankRow.rank}` : ", not ranked yet"}.`,
          `- Breakdown: ${Object.entries(byReason).map(([r, a]) => `${reasonLabel[r] ?? r} ${a}`).join(", ") || "no points yet"}.`,
          `- Spins ready: ${spinsReady}.`,
          "Use these real numbers when the player asks about their points; suggest concrete next steps to earn more.",
        ]
      : [
          "The visitor has no personal data: do not mention points totals, spins, ranks or any account details.",
          "Explain how the site, the gotcha machine and ApeGames work in general. If they ask about their own points, spins or wallet, tell them to sign in first.",
        ]),
    "Spin outcomes are drawn on-chain by Chainlink VRF; you cannot predict or influence results.",
    "Never discuss token trading, prices, or investment — there is no public token trading before the Charleston event.",
    "Keep answers short (2-4 sentences), upbeat, and concrete. If you don't know something, say so and suggest the dashboard or admin.",
  ].filter(Boolean).join("\n");

  const runIdFetch = createLovableAiGatewayRunIdFetch(getLovableAiGatewayRunId(request));
  const anthropic = createAnthropic({
    baseURL: GATEWAY,
    apiKey,
    headers: { "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
    fetch: runIdFetch.fetch,
  });

  const modelMessages = await convertToModelMessages(messages.slice(-20));

  const result = streamText({
    model: anthropic(MODEL),
    system,
    messages: modelMessages,
    maxOutputTokens: 1200,
    maxRetries: 0,
    abortSignal: request.signal,
  });

  const user = authed;
  if (user) {
    const { error: saveUserError } = await user.supabase.from("guide_messages").insert({
      user_id: user.userId,
      role: "user",
      parts: last.parts,
    } as never);
    if (saveUserError) console.error("[guide-chat] failed to save user message", saveUserError);
  }

  const response = result.toUIMessageStreamResponse({
    originalMessages: messages,
    ...(user
      ? {
          onFinish: async ({ responseMessage }) => {
            const { error } = await user.supabase.from("guide_messages").insert({
              user_id: user.userId,
              role: "assistant",
              parts: responseMessage.parts,
            } as never);
            if (error) console.error("[guide-chat] failed to save assistant message", error);
          },
        }
      : {}),
  });

  return withLovableAiGatewayRunIdHeader(response, runIdFetch, {
    "Cache-Control": "no-cache, no-transform",
  });
}
