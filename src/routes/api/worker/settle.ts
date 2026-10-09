import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

// Protected scheduled settlement worker (independent of any player's browser).
// Schedule: POST /api/worker/settle every minute with "Authorization: Bearer $LOVABLE_CRON_SECRET".
export const Route = createFileRoute("/api/worker/settle")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;
        const { runSettlement } = await import("@/lib/settlement.server");
        try {
          const report = await runSettlement();
          return new Response(JSON.stringify(report), { status: 200, headers: { "content-type": "application/json" } });
        } catch (e) {
          console.error("[worker/settle] failed", e);
          return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { "content-type": "application/json" } });
        }
      },
    },
  },
});
