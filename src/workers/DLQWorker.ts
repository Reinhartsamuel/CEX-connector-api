import Redis from "ioredis";
import { createLogger } from "../utils/logger";

const log = createLogger({ process: "worker-manager", component: "dlq-worker" });

const EXCHANGES = ["gate", "okx", "hyperliquid", "tokocrypto", "bitget", "mexc", "bitmart"];

export class DLQWorker {
  private readonly redis: Redis;
  private readonly retryIntervalMs: number;
  private readonly maxAttempts: number;
  private timer?: NodeJS.Timeout;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
    this.retryIntervalMs = Number(process.env.DLQ_RETRY_INTERVAL_MS || 5000);
    this.maxAttempts = Number(process.env.DLQ_MAX_ATTEMPTS || 5);
  }

  start() {
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.error({ err }, "DLQ tick failed"));
    }, this.retryIntervalMs);
  }

  private async tick() {
    for (const exchange of EXCHANGES) {
      const queue = `dlq:${exchange}`;
      const processing = `${queue}:processing`;
      const dead = `${queue}:dead`;
      const item = await this.redis.rpoplpush(queue, processing);
      if (!item) continue;

      try {
        const payload = JSON.parse(item) as { attempts?: number };
        const attempts = (payload.attempts || 0) + 1;

        if (attempts >= this.maxAttempts) {
          await this.redis.lrem(processing, 1, item);
          await this.redis.lpush(dead, JSON.stringify({ ...payload, attempts }));
          continue;
        }

        await this.redis.lrem(processing, 1, item);
        await this.redis.lpush(queue, JSON.stringify({ ...payload, attempts }));
      } catch {
        await this.redis.lrem(processing, 1, item);
        await this.redis.lpush(dead, item);
      }
    }
  }

  async getQueueSizes() {
    const out: Record<string, { queued: number; processing: number; dead: number }> = {};
    for (const exchange of EXCHANGES) {
      const base = `dlq:${exchange}`;
      const [queued, processing, dead] = await Promise.all([
        this.redis.llen(base),
        this.redis.llen(`${base}:processing`),
        this.redis.llen(`${base}:dead`),
      ]);
      out[exchange] = { queued, processing, dead };
    }
    return out;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.redis.quit();
  }
}
