import { createLogger, flushLogger } from "../utils/logger";
import { ControlRouter } from "./ControlRouter";
import { DLQWorker } from "./DLQWorker";
import { startHealthServer } from "./HealthServer";
import { startReconcileCron } from "./reconcileCron";

// Legacy workers are intentionally imported for compatibility mode.
import "./gateWorker";
import "./okxWorker";
import "./hyperliquidWorker";
import "./tokocryptoWorker";
import "./bitgetWorker";
import "./mexcWorker";
import "./bitmartWorker";

const log = createLogger({ process: "worker-manager" });
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const startedAt = Date.now();
const router = new ControlRouter(redisUrl);
const dlqWorker = new DLQWorker(redisUrl);

const reconcileTimer = startReconcileCron();
dlqWorker.start();
const healthServer = startHealthServer({
  startedAt,
  getDlqSizes: () => dlqWorker.getQueueSizes(),
});

router.start().catch((err) => {
  log.fatal({ err }, "ControlRouter fatal error");
  process.exit(1);
});

async function shutdown() {
  log.info("Shutting down worker manager");
  clearInterval(reconcileTimer);
  await router.stop();
  await dlqWorker.stop();
  healthServer.stop(true);
  await flushLogger();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
