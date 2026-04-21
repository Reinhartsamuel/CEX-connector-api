/* eslint-disable no-case-declarations */
import WebSocket from "ws";
import Redis from "ioredis";
import JSONbig from "json-bigint";
import { postgresDb } from "../db/client";
import { exchanges, Trade, trades } from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";
import crypto from "crypto";
import { decryptExchangeCreds } from "../utils/cryptography/decryptExchangeCreds";
import { createLogger, flushLogger } from "../utils/logger";
import { wsConnectionsActive, tradesClosedTotal, exchangeErrorsTotal } from "../utils/metrics";

const log = createLogger({ exchange: "bitget", process: "worker" });

// ---- Redis Setup ---- //
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const control = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const STREAM_KEY = "ws-control:bitget";
const GROUP_NAME = "bitget-workers";
const CONSUMER_NAME = `bitget-worker-${process.pid}`;

// Each user has exactly one WS connection
interface UserConnection {
  ws: WebSocket | null;
  pingInterval?: NodeJS.Timeout;
  backoff: number;
  intentionalClose?: boolean;
  contracts: Set<string>;
}
const connections = new Map<string, UserConnection>();

// ---- Redis Streams consumer for ws-control:bitget ---- //
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

    // Filter by exchange
    if (cmd.exchange && cmd.exchange !== "bitget") return;

    if (cmd.op === "open" && cmd.userId) {
      ensureConnection(cmd.userId, cmd.contract ? [cmd.contract] : undefined);
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
          eq(exchanges.exchange_title, "bitget"),
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

// ---- Fetch Bitget credentials via KMS decryption from DB ---- //
async function fetchCreds(userId: string) {
  const creds = await decryptExchangeCreds(userId);
  if (!creds || !creds.passphrase) return null;
  return { apiKey: creds.apiKey, apiSecret: creds.apiSecret, passphrase: creds.passphrase };
}

// ---- Build WebSocket auth payload ---- //
async function buildAuth(apiKey: string, apiSecret: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signaturePayload = timestamp + "GET" + "/user/verify";
  
  const sign = crypto
    .createHmac("sha256", apiSecret)
    .update(signaturePayload)
    .digest("base64");

  return {
    apiKey,
    passphrase: "", // Will be filled from creds
    timestamp,
    sign,
  };
}

// ------------------------------------------- //
//       MAIN CONNECTION MANAGEMENT
// ------------------------------------------- //

async function ensureConnection(
  userId: string,
  contractList: string[] = [],
) {
  let existing = connections.get(userId);

  if (existing?.ws && existing.ws.readyState === WebSocket.OPEN) {
    log.debug({ userId }, 'Connection already open');
    return;
  }

  const creds = await fetchCreds(userId);
  if (!creds) {
    log.warn({ userId }, 'No credentials found');
    return;
  }

  log.info({ userId }, 'Opening WebSocket connection');

  // Bitget WebSocket endpoint
  const wsUrl = "wss://ws.bitget.com/v2/ws";
  const ws = new WebSocket(wsUrl);

  const state: UserConnection = {
    ws,
    backoff: existing ? existing.backoff : 1000,
    contracts: new Set(contractList),
  };
  connections.set(userId, state);

  ws.on("open", () => onWsOpen(userId, ws, creds));
  ws.on("message", (raw: Buffer) => onWsMessage(userId, raw, ws));
  ws.on("close", (code, reason) => onWsClose(userId, code, reason));
  ws.on("error", (err) =>
    log.error({ err, userId }, 'WebSocket error'),
  );
}

function closeConnection(userId: string) {
  const state = connections.get(userId);
  if (!state) return;

  log.info({ userId }, 'Closing WebSocket connection');

  if (state.pingInterval) clearInterval(state.pingInterval);
  state.intentionalClose = true;
  if (state.ws) state.ws.close();
  connections.delete(userId);
}

// ------------------------------------------- //
//             EVENT HANDLERS
// ------------------------------------------- //

function onWsOpen(
  userId: string,
  ws: WebSocket,
  creds: { apiKey: string; apiSecret: string; passphrase: string },
) {
  log.info({ userId }, 'WebSocket open');

  const state = connections.get(userId);
  if (!state) return;

  // Reset backoff after successful connection
  state.backoff = 1000;

  // Login first
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signaturePayload = timestamp + "GET" + "/user/verify";
  const sign = crypto
    .createHmac("sha256", creds.apiSecret)
    .update(signaturePayload)
    .digest("base64");

  ws.send(JSON.stringify({
    op: "login",
    args: [{
      apiKey: creds.apiKey,
      passphrase: creds.passphrase,
      timestamp,
      sign,
    }],
  }));
}

async function onWsMessage(userId: string, raw: Buffer, ws: WebSocket) {
  let msg: any;
  try {
    msg = JSONbig.parse(raw.toString());
  } catch (err) {
    log.error({ err }, 'Failed to parse WS message');
    return;
  }

  // Handle login response
  if (msg.event === "login") {
    if (msg.code === 0) {
      log.info({ userId }, 'Login successful');
      
      // Subscribe to orders channel
      ws.send(JSON.stringify({
        op: "subscribe",
        args: [{
          instType: "USDT-FUTURES",
          channel: "orders",
          instId: "default",
        }],
      }));
      
      // Subscribe to positions channel
      ws.send(JSON.stringify({
        op: "subscribe",
        args: [{
          instType: "USDT-FUTURES",
          channel: "positions",
          instId: "default",
        }],
      }));
      
      log.info({ userId }, 'Subscribed to channels');
    } else {
      log.error({ userId, msg }, 'Login failed');
    }
    return;
  }

  // Handle subscription confirmation
  if (msg.event === "subscribe") {
    log.debug({ userId, arg: msg.arg }, 'Subscription confirmed');
    return;
  }

  // Handle order updates
  if (msg.arg?.channel === "orders" && msg.data) {
    return;
  }

  // Handle position updates
  if (msg.arg?.channel === "positions" && msg.data) {
    return;
  }

  // Handle pong
  if (msg.action === "pong") {
    log.debug({ userId }, 'Pong received');
    return;
  }
}

function onWsClose(userId: string, code: number, reason: Buffer) {
  log.warn({ userId, code, reason: reason.toString() }, 'WebSocket closed');

  const state = connections.get(userId);
  if (!state) return;

  if (state.pingInterval) clearInterval(state.pingInterval);

  const isIntentionalClose = !!state.intentionalClose;

  state.ws = null;
  connections.delete(userId);

  if (isIntentionalClose) {
    log.info({ userId }, 'WebSocket closed intentionally; skipping reconnect');
    return;
  }

  const delay = state.backoff;
  state.backoff = Math.min(state.backoff * 1.5, 60_000);

  log.info({ userId, delay }, 'Scheduling reconnect');

  setTimeout(() => ensureConnection(userId), delay);
}

// ------------------------------------------- //
//         ORDER UPDATE HANDLER
// ------------------------------------------- //

async function handleOrderUpdate(userId: string, data: any[]) {
  for (const order of data) {
    const event = classifyOrderEvent(order);
    log.debug({ userId }, 'Order update');

    let tradeData: Trade | null = null;
    if (order?.orderId) {
      try {
        const [row] = await postgresDb
          .select()
          .from(trades)
          .where(eq(trades.trade_id, String(order.orderId)));
        tradeData = row;
      } catch (e) {
        log.error({ err: e }, 'Error querying trade');
      }
    }

    switch (event) {
      case "order_filled_open":
        if (order.orderId) {
          await postgresDb
            .update(trades)
            .set({
              status: "waiting_targets",
              open_fill_price: order.avgPrice || order.price,
            })
            .where(eq(trades.trade_id, String(order.orderId)));
        }
        break;

      case "order_filled_close":
        if (order.orderId) {
          await postgresDb
            .update(trades)
            .set({
              status: "closed",
              closed_at: new Date(),
            })
            .where(eq(trades.trade_id, String(order.orderId)));
        }
        break;

      case "order_cancelled":
        if (order.orderId) {
          await postgresDb
            .update(trades)
            .set({ status: "cancelled" })
            .where(eq(trades.trade_id, String(order.orderId)));
        }
        break;

      case "order_partial_fill":
        if (order.orderId) {
          await postgresDb
            .update(trades)
            .set({ status: "partially_filled" })
            .where(eq(trades.trade_id, String(order.orderId)));
        }
        break;

      default:
        log.debug({}, 'Order event not handled');
    }

    await redis.publish(`user:${userId}:orders:chan`, JSON.stringify(order));
  }
}

// ------------------------------------------- //
//       POSITION UPDATE HANDLER
// ------------------------------------------- //

async function handlePositionUpdate(userId: string, data: any[]) {
  for (const position of data) {
    const symbol = position.symbol;
    const posSide = position.posSide; // long or short
    const size = parseFloat(position.holdQty || "0");
    const positionKey = `${symbol}:${posSide}`;

    log.debug({ userId }, 'Position update');

    if (size === 0) {
      // Position closed
      log.info({ positionKey }, 'Position closed');

      const exchange = await postgresDb.query.exchanges.findFirst({
        columns: { id: true },
        where: eq(exchanges.exchange_user_id, String(userId)),
      });

      if (exchange) {
        const unrealizedPnl = position.unrealizedPL || "0";
        await postgresDb
          .update(trades)
          .set({
            status: "closed",
            closed_at: new Date(),
            pnl: unrealizedPnl,
          })
          .where(
            and(
              eq(trades.status, "waiting_targets"),
              eq(trades.contract, symbol),
              eq(trades.exchange_id, exchange.id),
            )
          );
      }

      await redis.hdel(`user:${userId}:positions`, positionKey);
    } else {
      // Update position cache
      await redis.hset(
        `user:${userId}:positions`,
        positionKey,
        JSON.stringify(position),
      );
    }
  }

  await redis.publish(`user:${userId}:positions:chan`, JSON.stringify(data));
}

// ------------------------------------------- //
//         EVENT CLASSIFICATION
// ------------------------------------------- //

type OrderEvent =
  | "order_filled_open"
  | "order_filled_close"
  | "order_cancelled"
  | "order_partial_fill"
  | "order_other";

function classifyOrderEvent(order: any): OrderEvent {
  const status = order?.status; // new, partially_filled, fully_paid, cancelled
  const filledQty = parseFloat(order?.filledQty || "0");
  const totalQty = parseFloat(order?.totalQty || "0");
  const reduceOnly = order?.reduceOnly === "true" || order?.reduceOnly === true;

  if (status === "fully_paid" || status === "full-fill") {
    if (reduceOnly) {
      return "order_filled_close";
    }
    return "order_filled_open";
  }

  if (status === "cancelled" || status === "cancel") {
    return "order_cancelled";
  }

  if (status === "partially_filled" || (filledQty > 0 && filledQty < totalQty)) {
    return "order_partial_fill";
  }

  return "order_other";
}

// ------------------------------------------- //
//         GRACEFUL SHUTDOWN
// ------------------------------------------- //

process.on("SIGINT", () => {
  log.info('Shutting down');

  for (const [userId, st] of connections.entries()) {
    if (st.ws) st.ws.terminate();
  }
  process.exit(0);
});

log.info('Worker started successfully');