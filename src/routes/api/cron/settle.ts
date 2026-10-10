import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

// Protected settlement worker endpoint. Call on a schedule with `Authorization: Bearer <LOVABLE_CRON_SECRET>`.
export const Route = createFileRoute("/api/cron/settle")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;
        const { runWorker } = await import("@/lib/worker.server");
        try {
          return Response.json(await runWorker());
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 500 });
        }
      },
    },
  },
});
