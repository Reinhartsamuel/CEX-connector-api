import Redis from "ioredis";
import { createLogger } from "../utils/logger";

const log = createLogger({ process: "worker-manager", component: "control-router" });

type ExchangeId = "gate" | "okx" | "hyperliquid" | "tokocrypto" | "bitget" | "mexc" | "bitmart";

const EXCHANGES: ExchangeId[] = ["gate", "okx", "hyperliquid", "tokocrypto", "bitget", "mexc", "bitmart"];
const STREAM_KEY = "ws-control";
const GROUP_NAME = "worker-manager";
const CONSUMER_NAME = `worker-manager-${process.pid}`;

function parseFields(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
  return obj;
}

function isExchangeId(value: string): value is ExchangeId {
  return EXCHANGES.includes(value as ExchangeId);
}

export class ControlRouter {
  private readonly control: Redis;
  private readonly publish: Redis;
  private stopped = false;

  constructor(redisUrl: string) {
    this.control = new Redis(redisUrl);
    this.publish = new Redis(redisUrl);
  }

  async start(): Promise<void> {
    try {
      await this.control.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "$", "MKSTREAM");
    } catch (err: any) {
      if (!err.message?.includes("BUSYGROUP")) throw err;
    }

    log.info({ stream: STREAM_KEY, group: GROUP_NAME }, "ControlRouter started");

    while (!this.stopped) {
      const result = await this.control.xreadgroup(
        "GROUP", GROUP_NAME, CONSUMER_NAME,
        "COUNT", "20",
        "BLOCK", "5000",
        "STREAMS", STREAM_KEY, ">",
      ) as any;

      if (!result) continue;

      for (const [, messages] of result) {
        for (const [id, fields] of messages as [string, string[]][]) {
          await this.routeMessage(id, fields);
        }
      }
    }
  }

  private async routeMessage(id: string, fields: string[]) {
    try {
      const cmd = parseFields(fields);
      if (!isExchangeId(cmd.exchange || "")) {
        log.warn({ id, cmd }, "Dropping control message without valid exchange");
        await this.control.xack(STREAM_KEY, GROUP_NAME, id);
        return;
      }

      const targetStream = `ws-control:${cmd.exchange}`;
      await this.publish.xadd(targetStream, "*", ...fields);
      await this.control.xack(STREAM_KEY, GROUP_NAME, id);
    } catch (err) {
      log.error({ err, id }, "Failed routing control message");
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.control.quit();
    await this.publish.quit();
  }
}
