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
  if (!token || token.split(".").length !== 3) return jsonError(401, "Sign in to chat with the guide.");

  const supabase = authedClient(token);
  const { data: claims, error: authError } = await supabase.auth.getClaims(token);
  if (authError || !claims?.claims?.sub) return jsonError(401, "Sign in to chat with the guide.");
  const userId = claims.claims.sub as string;

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

  // Live context for the guide: active prizes and the NFT settings players may read.
  const [prizesRes, nftRes] = await Promise.all([
    supabase.from("prizes").select("name, rarity, points").eq("active", true),
    supabase.from("app_config").select("value").eq("key", "nft").maybeSingle(),
  ]);
  const prizes = (prizesRes.data ?? []) as { name: string; rarity: string; points: number }[];
  const nft = (nftRes.data?.value ?? {}) as { burn_min_level?: number; opensea_url?: string };

  const system = [
    "You are the ApeGames Gotcha guide — a friendly, energetic arcade host for the Go ApeGames 2026 pre-event gacha.",
    "Answer questions about how the app works: linking an ApeChain wallet, earning holding points from ApeGames NFTs, spinning the gotcha machine, prizes and rarity, the leaderboard, and the Charleston event.",
    `Burning an NFT of Level ${nft.burn_min_level ?? 4} or higher grants a free spin. The NFT collection is on ApeChain${nft.opensea_url ? ` (OpenSea: ${nft.opensea_url})` : ""}.`,
    prizes.length
      ? `Current prizes: ${prizes.map((p) => `${p.name} (${p.rarity}, ${p.points} pts)`).join("; ")}.`
      : "Prizes are being configured.",
    "Spin outcomes are drawn on-chain by Chainlink VRF; you cannot predict or influence results.",
    "Never discuss token trading, prices, or investment — there is no public token trading before the Charleston event.",
    "Keep answers short (2-4 sentences), upbeat, and concrete. If you don't know something, say so and suggest the dashboard or admin.",
  ].join("\n");

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

  // Persist the player's message now; the assistant reply is saved in onFinish.
  const { error: saveUserError } = await supabase.from("guide_messages").insert({
    user_id: userId,
    role: "user",
    parts: last.parts,
  } as never);
  if (saveUserError) console.error("[guide-chat] failed to save user message", saveUserError);

  const response = result.toUIMessageStreamResponse({
    originalMessages: messages,
    onFinish: async ({ responseMessage }) => {
      const { error } = await supabase.from("guide_messages").insert({
        user_id: userId,
        role: "assistant",
        parts: responseMessage.parts,
      } as never);
      if (error) console.error("[guide-chat] failed to save assistant message", error);
    },
  });

  return withLovableAiGatewayRunIdHeader(response, runIdFetch, {
    "Cache-Control": "no-cache, no-transform",
  });
}
