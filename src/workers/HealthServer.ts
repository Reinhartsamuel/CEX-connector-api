import { metricsRegistry } from "../utils/metrics";

type HealthContext = {
  startedAt: number;
  getDlqSizes: () => Promise<Record<string, { queued: number; processing: number; dead: number }>>;
};

export function startHealthServer(ctx: HealthContext) {
  const port = Number(process.env.WORKER_HEALTH_PORT || 9000);

  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        const dlq = await ctx.getDlqSizes();
        return Response.json({
          status: "ok",
          process: "worker-manager",
          uptime_s: Math.floor((Date.now() - ctx.startedAt) / 1000),
          dlq,
        });
      }

      if (url.pathname === "/metrics") {
        return new Response(await metricsRegistry.metrics(), {
          headers: { "content-type": metricsRegistry.contentType },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });
}
