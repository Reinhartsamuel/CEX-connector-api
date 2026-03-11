import Redis from "ioredis";

/**
 * Channel naming convention for WS ready signals.
 * Workers publish to this channel after WS connect + subscribe completes.
 * Executors subscribe and wait before placing orders.
 */
export function wsReadyChannel(exchange: string, userId: string): string {
  return `ws-ready:${exchange}:${userId}`;
}

/**
 * Wait for a WS worker to signal readiness on Redis pub/sub.
 *
 * Creates a temporary subscriber, listens for the ready signal,
 * and resolves once received or after timeout.
 *
 * @returns true if ready signal received, false if timed out
 */
export async function waitForWsReady(
  redisUrl: string,
  exchange: string,
  userId: string,
  timeoutMs: number = 5000,
): Promise<boolean> {
  const channel = wsReadyChannel(exchange, userId);
  const subscriber = new Redis(redisUrl);

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        console.log(`[wsReady] Timeout waiting for ${channel} (${timeoutMs}ms) — proceeding anyway`);
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.quit().catch(() => {});
        resolve(false);
      }
    }, timeoutMs);

    subscriber.subscribe(channel, (err) => {
      if (err) {
        console.error(`[wsReady] Failed to subscribe to ${channel}:`, err);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          subscriber.quit().catch(() => {});
          resolve(false);
        }
      }
    });

    subscriber.on("message", (chan, msg) => {
      if (chan === channel && !settled) {
        settled = true;
        clearTimeout(timer);
        console.log(`[wsReady] Received ready signal on ${channel}: ${msg}`);
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.quit().catch(() => {});
        resolve(true);
      }
    });
  });
}

/**
 * Publish a WS ready signal. Called by workers after successful subscribe.
 */
export async function publishWsReady(
  redis: Redis,
  exchange: string,
  userId: string,
): Promise<void> {
  const channel = wsReadyChannel(exchange, userId);
  await redis.publish(channel, JSON.stringify({ ready: true, ts: Date.now() }));
  console.log(`[wsReady] Published ready signal on ${channel}`);
}
