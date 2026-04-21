import WebSocket from "ws";
import Redis from "ioredis";
import { postgresDb } from "../db/client";
import { exchanges, trades } from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { signRequestOkxWs, signRequestOkx } from "../utils/authentication/signRequestOkx";
import { publishWsReady } from "../utils/wsReady";
import { decryptExchangeCreds } from "../utils/cryptography/decryptExchangeCreds";
import { createLogger, flushLogger } from "../utils/logger";
import { wsConnectionsActive, tradesClosedTotal, exchangeErrorsTotal } from "../utils/metrics";

const log = createLogger({ exchange: "okx", process: "worker" });

// ---- Redis Setup ---- //
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const control = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const STREAM_KEY = "ws-control:okx";
const GROUP_NAME = "okx-workers";
const CONSUMER_NAME = `okx-worker-${process.pid}`;
const OKX_BASE_URL = "https://www.okx.com";

// Each user has exactly one WS connection.
interface OkxConnection {
  ws: WebSocket | null;
  pingInterval?: NodeJS.Timeout;
  backoff: number;
  intentionalClose?: boolean;
  loggedIn: boolean;
}
const connections = new Map<string, OkxConnection>();

// ---- Redis Streams consumer for ws-control:okx ---- //
async function startStreamConsumer() {
  try {
    await control.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "$", "MKSTREAM");
    log.info({ group: GROUP_NAME, stream: STREAM_KEY }, 'Created consumer group');
  } catch (err: any) {
    if (!err.message?.includes("BUSYGROUP")) throw err;
  }

  try {
    const claimed = await (control as any).xautoclaim(
      STREAM_KEY, GROUP_NAME, CONSUMER_NAME,
      30_000, "0-0", "COUNT", "100",
    );
    const messages = Array.isArray(claimed) ? (claimed[1] ?? []) : [];
    if (messages.length > 0) {
      log.info({ count: messages.length }, 'Reclaimed pending messages on startup');
      for (const [id, fields] of messages) {
        await handleStreamMessage(id, fields);
      }
    }
  } catch (err) {
    log.error({ err }, 'XAUTOCLAIM failed on startup');
  }

  log.info('Listening for control commands via Redis Streams');
  while (true) {
    try {
      const results = await control.xreadgroup(
        "GROUP", GROUP_NAME, CONSUMER_NAME,
        "COUNT", "10",
        "BLOCK", "5000",
        "STREAMS", STREAM_KEY, ">",
      ) as any;

      if (!results) continue;

      for (const [, messages] of results) {
        for (const [id, fields] of messages) {
          await handleStreamMessage(id, fields);
        }
      }
    } catch (err) {
      log.error({ err }, 'Stream read error');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function parseStreamFields(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
  return obj;
}

async function handleStreamMessage(id: string, fields: string[]) {
  try {
    const cmd = parseStreamFields(fields);

    if (cmd.op === "open" && cmd.userId) {
      ensureConnection(cmd.userId);
    } else if (cmd.op === "close" && cmd.userId) {
      closeConnection(cmd.userId);
    }

    await control.xack(STREAM_KEY, GROUP_NAME, id);
  } catch (err) {
    log.error({ err, messageId: id }, 'Error handling stream message');
  }
}

startStreamConsumer().catch((err) => {
  log.fatal({ err }, 'Stream consumer fatal error');
  process.exit(1);
});

// ---- Restore connections for users with active trades on startup ---- //
async function restoreConnections() {
  log.info('Restoring connections for users with active trades');

  try {
    const activeTrades = await postgresDb
      .selectDistinct({ exchange_user_id: exchanges.exchange_user_id })
      .from(trades)
      .innerJoin(exchanges, eq(trades.exchange_id, exchanges.id))
      .where(
        and(
          eq(exchanges.exchange_title, "okx"),
          inArray(trades.status, ["waiting_position", "partially_filled", "waiting_targets"]),
        ),
      );

    log.info({ count: activeTrades.length }, 'Found users with active trades to reconnect');

    for (const { exchange_user_id } of activeTrades) {
      ensureConnection(exchange_user_id);
    }
  } catch (err) {
    log.error({ err }, 'Failed to restore connections on startup');
  }
}

restoreConnections();

// ---- Fetch OKX credentials via KMS decryption from DB ---- //
async function fetchCreds(userId: string) {
  const creds = await decryptExchangeCreds(userId);
  if (!creds || !creds.passphrase) return null;
  return { apiKey: creds.apiKey, apiSecret: creds.apiSecret, passphrase: creds.passphrase };
}

// ------------------------------------------- //
//       MAIN CONNECTION MANAGEMENT
// ------------------------------------------- //

async function ensureConnection(userId: string) {
  const existing = connections.get(userId);

  if (existing?.ws && existing.ws.readyState === WebSocket.OPEN) {
    log.debug({ userId }, "Connection already open");
    publishWsReady(redis, "okx", userId).catch(() => {});
    return;
  }

  const creds = await fetchCreds(userId);
  if (!creds) {
    log.warn({ userId }, "No credentials found");
    return;
  }

  log.info({ userId }, "Opening WebSocket connection");

  const ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/private");

  const state: OkxConnection = {
    ws,
    backoff: existing ? existing.backoff : 1000,
    loggedIn: false,
  };
  connections.set(userId, state);

  ws.on("open", () => onWsOpen(userId, ws, creds));
  ws.on("message", (raw: Buffer) => onWsMessage(userId, raw, creds));
  ws.on("close", (code, reason) => onWsClose(userId, code, reason));
  ws.on("error", (err) => {
    log.error({ err, userId }, "WebSocket error");
    exchangeErrorsTotal.inc({ exchange: "okx", component: "worker" });
  });
}

// ------------------------------------------- //
//             EVENT HANDLERS
// ------------------------------------------- //

function onWsOpen(
  userId: string,
  ws: WebSocket,
  creds: { apiKey: string; apiSecret: string; passphrase: string },
) {
  log.info({ userId }, "WebSocket open");
  wsConnectionsActive.inc({ exchange: "okx" });

  const state = connections.get(userId);
  if (!state) return;

  // Reset backoff after successful connection
  state.backoff = 1000;

  // OKX requires login before subscribing
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signRequestOkxWs(timestamp, "GET", "/users/self/verify", creds.apiSecret);

  ws.send(
    JSON.stringify({
      op: "login",
      args: [
        {
          apiKey: creds.apiKey,
          passphrase: creds.passphrase,
          timestamp,
          sign: signature,
        },
      ],
    }),
  );
  log.info({ userId }, "Login sent");

  // Setup ping interval (OKX requires "ping" text every 30s)
  if (state.pingInterval) clearInterval(state.pingInterval);

  state.pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send("ping");
    }
  }, 25_000);
}

async function onWsMessage(
  userId: string,
  raw: Buffer,
  creds: { apiKey: string; apiSecret: string; passphrase: string },
) {
  const rawStr = raw.toString();

  // OKX sends "pong" as plain text
  if (rawStr === "pong") return;

  let msg: any;
  try {
    msg = JSON.parse(rawStr);
  } catch (err) {
    log.error({ err }, "Failed to parse WS message");
    return;
  }

  // Handle login response
  if (msg.event === "login") {
    if (msg.code === "0") {
      log.info({ userId }, "Login success");

      const state = connections.get(userId);
      if (state) state.loggedIn = true;

      // Subscribe to orders and positions
      const ws = state?.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            op: "subscribe",
            args: [
              { channel: "orders", instType: "SWAP" },
              { channel: "positions", instType: "SWAP" },
            ],
          }),
        );
        log.info({ userId, channels: ["orders", "positions"] }, "Subscribed");
      }

      // Signal that WS is ready so executors can proceed with order placement
      publishWsReady(redis, "okx", userId).catch((err) =>
        log.error({ err, userId }, "Failed to publish ws-ready"),
      );

      // Run snapshot reconciliation after subscribing
      reconcileSnapshot(userId, creds).catch((err) =>
        log.error({ err, userId }, "Reconciliation failed"),
      );
    } else {
      log.error({ userId, code: msg.code, msg: msg.msg }, "Login failed");
      exchangeErrorsTotal.inc({ exchange: "okx", component: "worker" });
    }
    return;
  }

  // Handle subscription confirmation
  if (msg.event === "subscribe") {
    log.debug({ userId, arg: msg.arg }, "Subscription confirmed");
    return;
  }

  // Handle order updates
  if (msg.arg?.channel === "orders" && msg.data) {
    for (const order of msg.data) {
      await handleOrderUpdate(userId, order);
    }
    return;
  }

  // Handle position updates
  if (msg.arg?.channel === "positions" && msg.data) {
    for (const position of msg.data) {
      await handlePositionUpdate(userId, position);
    }
    return;
  }
}

function onWsClose(userId: string, code: number, reason: Buffer) {
  log.warn({ userId, code, reason: reason.toString() }, "WebSocket closed");
  wsConnectionsActive.dec({ exchange: "okx" });

  const state = connections.get(userId);
  if (!state) return;

  if (state.pingInterval) clearInterval(state.pingInterval);

  const isIntentionalClose = !!state.intentionalClose;

  state.ws = null;
  state.loggedIn = false;
  connections.delete(userId);

  if (isIntentionalClose) {
    log.info({ userId }, "WebSocket closed intentionally; skipping reconnect");
    return;
  }

  // Schedule reconnect with exponential backoff
  const delay = state.backoff;
  state.backoff = Math.min(state.backoff * 1.5, 60_000);

  log.info({ userId, delay }, "Scheduling reconnect");
  setTimeout(() => ensureConnection(userId), delay);
}

// ------------------------------------------- //
//          CLOSE USER CONNECTION
// ------------------------------------------- //

function closeConnection(userId: string) {
  log.info({ userId }, "Closing WebSocket connection");

  const st = connections.get(userId);
  if (!st) return;

  if (st.pingInterval) clearInterval(st.pingInterval);

  st.intentionalClose = true;

  if (st.ws && st.ws.readyState === WebSocket.OPEN) {
    st.ws.close();
  }

  connections.delete(userId);
}

// ------------------------------------------- //
//             GRACEFUL SHUTDOWN
// ------------------------------------------- //

async function shutdown() {
  log.info("Shutting down");
  for (const [, st] of connections.entries()) {
    if (st.ws) st.ws.terminate();
  }
  await flushLogger();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ------------------------------------------- //
//          MESSAGE HANDLERS
// ------------------------------------------- //

async function handleOrderUpdate(userId: string, order: any) {
  try {
    const ordId = order.ordId;
    const state = order.state; // live, partially_filled, filled, canceled

    log.debug({ userId, ordId, state, instId: order.instId }, "Order update");

    let dbStatus: string | null = null;
    switch (state) {
      case "live":
        dbStatus = "waiting_position";
        break;
      case "filled":
        dbStatus = "waiting_targets";
        break;
      case "partially_filled":
        dbStatus = "partially_filled";
        break;
      case "canceled":
        dbStatus = "cancelled";
        break;
      default:
        log.debug({ state }, "Unknown order state");
    }

    if (!dbStatus) return;

    // Find trade by ordId
    const [trade] = await postgresDb
      .select()
      .from(trades)
      .where(eq(trades.trade_id, ordId))
      .limit(1);

    if (!trade) {
      log.warn({ ordId }, "Trade not found, skipping");
      return;
    }

    const updateData: any = { status: dbStatus };

    if (state === "filled") {
      updateData.open_fill_price = order.avgPx || order.px;
      updateData.open_filled_at = order.fillTime ? Math.floor(Number(order.fillTime) / 1000) : undefined;
    }

    if (state === "canceled") {
      updateData.cancelled_at = new Date();
    }

    await postgresDb
      .update(trades)
      .set(updateData)
      .where(eq(trades.id, trade.id));

    log.info({ tradeId: trade.id, status: dbStatus }, "Trade updated");

    // Publish to Redis for UI
    await redis.publish(`user:${userId}:okx:orders:chan`, JSON.stringify(order));
  } catch (err) {
    log.error({ err, userId }, "Error handling order update");
    exchangeErrorsTotal.inc({ exchange: "okx", component: "worker" });
  }
}

async function handlePositionUpdate(userId: string, position: any) {
  try {
    const instId = position.instId;
    const pos = parseFloat(position.pos || "0");

    log.debug({ userId, instId, pos }, "Position update");

    // If position is closed (pos === 0), find and close matching trades
    if (pos === 0) {
      const exchange = await postgresDb.query.exchanges.findFirst({
        columns: { id: true },
        where: eq(exchanges.exchange_user_id, userId),
      });

      if (!exchange) {
        log.warn({ userId }, "No exchange found");
        return;
      }

      // Find the most recent waiting_targets trade for this instrument
      const [trade] = await postgresDb
        .select()
        .from(trades)
        .where(
          and(
            eq(trades.exchange_id, exchange.id),
            eq(trades.contract, instId),
            eq(trades.status, "waiting_targets"),
          ),
        )
        .limit(1);

      if (trade) {
        await postgresDb
          .update(trades)
          .set({
            status: "closed",
            closed_at: new Date(),
            pnl: position.realizedPnl || position.pnl || "0",
          })
          .where(eq(trades.id, trade.id));

        log.info({ tradeId: trade.id, instId }, "Trade closed via position update");
        tradesClosedTotal.inc({ exchange: "okx" });
      }
    }

    // Publish to Redis for UI
    await redis.publish(`user:${userId}:okx:positions:chan`, JSON.stringify(position));
  } catch (err) {
    log.error({ err, userId }, "Error handling position update");
    exchangeErrorsTotal.inc({ exchange: "okx", component: "worker" });
  }
}

// ------------------------------------------- //
//        SNAPSHOT RECONCILIATION
// ------------------------------------------- //

/**
 * After WS login + subscribe, poll REST API to catch any order/position changes
 * that happened before the WS connection was established.
 */
async function reconcileSnapshot(
  userId: string,
  creds: { apiKey: string; apiSecret: string; passphrase: string },
) {
  log.info({ userId }, "Starting snapshot reconciliation");

  const exchange = await postgresDb.query.exchanges.findFirst({
    columns: { id: true },
    where: eq(exchanges.exchange_user_id, userId),
  });
  if (!exchange) {
    log.warn({ userId }, "No exchange record found for reconcile");
    return;
  }

  // ---- Phase 1: Reconcile pending orders ----
  const pendingTrades = await postgresDb
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.exchange_id, exchange.id),
        inArray(trades.status, ["waiting_position", "partially_filled"]),
      ),
    );

  log.info({ userId, count: pendingTrades.length }, "Pending trades to reconcile");

  for (const trade of pendingTrades) {
    try {
      const orderData = await okxRestGetOrder(creds, trade.contract, trade.trade_id);
      if (!orderData || orderData.status === "error") {
        log.warn({ tradeId: trade.trade_id }, "Failed to fetch order for reconcile");
        continue;
      }

      // OKX REST response: { code: "0", data: [{ state, avgPx, fillTime, ... }] }
      const order = orderData?.data?.[0];
      if (!order) continue;

      const state = order.state;
      log.debug({ tradeId: trade.trade_id, state }, "Order REST state");

      if (state === "filled") {
        await postgresDb
          .update(trades)
          .set({
            status: "waiting_targets",
            open_fill_price: order.avgPx || order.px,
            open_filled_at: order.fillTime ? Math.floor(Number(order.fillTime) / 1000) : undefined,
          })
          .where(eq(trades.id, trade.id));
        log.info({ tradeId: trade.id }, "Trade reconciled → waiting_targets");
      } else if (state === "canceled") {
        await postgresDb
          .update(trades)
          .set({ status: "cancelled", cancelled_at: new Date() })
          .where(eq(trades.id, trade.id));
        log.info({ tradeId: trade.id }, "Trade reconciled → cancelled");
      }
    } catch (err) {
      log.error({ err, tradeId: trade.trade_id }, "Error checking order for reconcile");
      exchangeErrorsTotal.inc({ exchange: "okx", component: "reconcile" });
    }
  }

  // ---- Phase 2: Reconcile open positions ----
  const waitingTrades = await postgresDb
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.exchange_id, exchange.id),
        eq(trades.status, "waiting_targets"),
      ),
    );

  if (waitingTrades.length === 0) {
    log.debug({ userId }, "No waiting_targets trades to check");
    return;
  }

  const positionsData = await okxRestGetPositions(creds);
  if (!positionsData || positionsData.status === "error") {
    log.warn({ userId }, "Failed to fetch positions for reconcile");
    return;
  }

  // Build set of instIds that have an open position
  const openPositionInstIds = new Set<string>();
  for (const pos of positionsData?.data || []) {
    if (parseFloat(pos.pos || "0") !== 0) {
      openPositionInstIds.add(pos.instId);
    }
  }

  log.debug({ userId, instruments: [...openPositionInstIds] }, "Open position instruments");

  for (const trade of waitingTrades) {
    if (!openPositionInstIds.has(trade.contract)) {
      log.info({ tradeId: trade.id, contract: trade.contract }, "Trade has no open position — marking closed");
      await postgresDb
        .update(trades)
        .set({ status: "closed", closed_at: new Date() })
        .where(eq(trades.id, trade.id));
    }
  }

  log.info({ userId }, "Snapshot reconciliation complete");
}

// ---- OKX REST helpers (avoids singleton OkxServices state issue) ----

async function okxRestGetOrder(
  creds: { apiKey: string; apiSecret: string; passphrase: string },
  instId: string,
  ordId: string,
) {
  const requestPath = `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`;
  const headers = signRequestOkx(
    { key: creds.apiKey, secret: creds.apiSecret, passphrase: creds.passphrase },
    { method: "GET", requestPath },
  );

  const response = await fetch(`${OKX_BASE_URL}${requestPath}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", ...headers },
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { status: "error" as const, message: errorText, statusCode: response.status };
  }

  return await response.json();
}

async function okxRestGetPositions(
  creds: { apiKey: string; apiSecret: string; passphrase: string },
) {
  const requestPath = "/api/v5/account/positions?instType=SWAP";
  const headers = signRequestOkx(
    { key: creds.apiKey, secret: creds.apiSecret, passphrase: creds.passphrase },
    { method: "GET", requestPath },
  );

  const response = await fetch(`${OKX_BASE_URL}${requestPath}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", ...headers },
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { status: "error" as const, message: errorText, statusCode: response.status };
  }

  return await response.json();
}

log.info("OKX Worker started successfully");
