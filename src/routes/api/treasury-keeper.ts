// The keeper bot's trigger: pg_cron calls this every 10 minutes (drizzle 0023). It needs no secret: a run only
// does what the treasury settings and the chain allow, the database lock keeps runs at least 8 minutes apart and
// never overlapping, and the reply says only whether it ran (details are on Admin → Treasury).
import { createFileRoute } from "@tanstack/react-router";

async function handle() {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  try {
    const { runKeeper } = await import("@/lib/treasury-keeper.server");
    const r = await runKeeper("cron");
    return json({ ran: r.ran, ...("reason" in r ? { reason: r.reason } : {}) });
  } catch {
    return json({ ran: false, reason: "The keeper couldn't start (see Admin → Treasury)." }, 500);
  }
}

export const Route = createFileRoute("/api/treasury-keeper")({
  server: {
    handlers: {
      POST: () => handle(),
    },
  },
});
