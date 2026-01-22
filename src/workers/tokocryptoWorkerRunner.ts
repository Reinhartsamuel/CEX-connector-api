/* eslint-disable no-case-declarations */
import WebSocket from "ws";
import Redis from "ioredis";
import JSONbig from "json-bigint";
import { postgresDb } from "../db/client";
import { exchanges, Trade, trades } from "../db/schema";
import { and, desc, eq } from "drizzle-orm";
import crypto from "crypto";

// ---- Redis Setup ---- //
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const control = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const CTRL_CHANNEL = "ws-control";

// Each user has exactly one WS connection
interface UserConnection {
  ws: WebSocket | null;
  pingInterval?: NodeJS.Timeout;
  backoff: number;
  contracts: Set<string>;
}
const connections = new Map<string, UserConnection>();

// ---- Subscribe to control channel ---- //
(async () => {
  console.log("WS Worker: Listening for control commands...");
  await control.subscribe(CTRL_CHANNEL);

  control.on("message", (chan, msg) => {
    if (chan !== CTRL_CHANNEL) return;

    try {
      const cmd = JSON.parse(msg);

      if (cmd.op === "open" && cmd.userId) {
        ensureConnection(cmd.userId, cmd.contracts);
      }

      if (cmd.op === "close" && cmd.userId) {
        closeConnection(cmd.userId);
      }
    } catch (err) {
      console.error("WS Worker: invalid control command:", msg, err);
    }
  });
})();

// ---- Fetch Tokocrypto credentials from Redis ---- //
async function fetchCreds(userId: string) {
  const data = await redis.hgetall(`tokocrypto:creds:${userId}`);
  if (!data || !data.apiKey || !data.apiSecret) return null;
  return { apiKey: data.apiKey, apiSecret: data.apiSecret };
}

// ---- Build WebSocket auth signature (Binance-style) ---- //
async function buildSignature(apiSecret: string, timestamp: number) {
  const signaturePayload = `timestamp=${timestamp}`;
  const sign = crypto
    .createHmac("sha256", apiSecret)
    .update(signaturePayload)
    .digest("hex");
  return sign;
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
    console.log(`WS Worker: connection already open for user ${userId}`);
    return;
  }

  const creds = await fetchCreds(userId);
  if (!creds) {
    console.warn(`WS Worker: No credentials found for user ${userId}`);
    return;
  }

  console.log(`WS Worker: Opening WS for user ${userId}`);

  // Tokocrypto uses Binance Cloud WebSocket
  const wsUrl = "wss://stream-tokocrypto.com/stream";
  const ws = new WebSocket(wsUrl);

  const state: UserConnection = {
    ws,
    backoff: existing ? existing.backoff : 1000,
    contracts: new Set(contractList),
  };
  connections.set(userId, state);

  ws.on("open", () => onWsOpen(userId, ws, creds));
  ws.on("message", (raw: Buffer) => onWsMessage(userId, raw));
  ws.on("close", (code, reason) => onWsClose(userId, code, reason));
  ws.on("error", (err) =>
    console.error(`WS Worker: WS error (${userId})`, err),
  );
}

function closeConnection(userId: string) {
  const state = connections.get(userId);
  if (!state) return;

  console.log(`WS Worker: Closing connection for user ${userId}`);

  if (state.pingInterval) clearInterval(state.pingInterval);
  if (state.ws) state.ws.terminate();
  connections.delete(userId);
}

// ------------------------------------------- //
//             EVENT HANDLERS
// ------------------------------------------- //

function onWsOpen(
  userId: string,
  ws: WebSocket,
  creds: { apiKey: string; apiSecret: string },
) {
  console.log(`WS Worker: WS OPEN for user ${userId}`);

  const state = connections.get(userId);
  if (!state) return;

  // Reset backoff after successful connection
  state.backoff = 1000;

  // Subscribe to user data stream (Binance-style)
  // For Tokocrypto/Binance, we subscribe to user data stream
  const streams = [
    "btcusdt@ticker",
    "ethusdt@ticker",
    // Add more streams as needed
  ];

  ws.send(
    JSON.stringify({
      method: "SUBSCRIBE",
      params: streams,
      id: 1,
    }),
  );
  console.log(`📡 SUBSCRIBED to streams for user=${userId}`);

  // Setup ping interval (Binance requires ping every 3 minutes)
  if (state.pingInterval) clearInterval(state.pingInterval);

  state.pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      console.log(`🏓 PING → user=${userId}`);
    }
  }, 180_000); // 3 minutes
}

async function onWsMessage(userId: string, raw: Buffer) {
  let msg: any;
  try {
    msg = JSONbig.parse(raw.toString());
  } catch (err) {
    console.error("WS Worker: failed to parse WS message", err);
    return;
  }

  // Handle subscription response
  if (msg?.result === null && msg?.id) {
    console.log(`✅ Subscription confirmed for user=${userId}`);
    return;
  }

  // Handle order updates (Binance-style)
  if (msg?.e === "ORDER_TRADE_UPDATE") {
    await handleOrderUpdate(userId, msg);
  }

  // Handle position updates (Binance-style)
  if (msg?.e === "ACCOUNT_UPDATE") {
    await handlePositionUpdate(userId, msg);
  }
}

function onWsClose(userId: string, code: number, reason: Buffer) {
  console.warn(
    `WS Worker: WS CLOSED user=${userId} code=${code} reason=${reason.toString()}`,
  );

  const state = connections.get(userId);
  if (!state) return;

  // Clean up ping interval
  if (state.pingInterval) clearInterval(state.pingInterval);

  // Remove stale WebSocket reference
  state.ws = null;
  connections.delete(userId);

  // Exponential backoff strategy
  const delay = state.backoff;
  state.backoff = Math.min(state.backoff * 1.5, 60_000); // Max 60s backoff

  console.log(`WS Worker: Reconnecting user ${userId} in ${delay}ms...`);

  // Schedule reconnection
  setTimeout(() => ensureConnection(userId), delay);
}

// ------------------------------------------- //
//         ORDER UPDATE HANDLER
// ------------------------------------------- //

async function handleOrderUpdate(userId: string, msg: any) {
  const order = msg.o;
  const event = classifyOrderEvent(order);

  console.log(`📥 ORDER UPDATE (${userId}): event=${event}`, order);

  let tradeData: Trade | null = null;
  if (order?.i) {
    try {
      const [row] = await postgresDb
        .select()
        .from(trades)
        .where(eq(trades.trade_id, String(order.i)));
      tradeData = row;
    } catch (e) {
      console.error(e, "error query");
    }
  }

  // Handle events
  switch (event) {
    case "order_filled_open":
      if (order.i) {
        console.log(`Updating trade ${order.i} to "waiting_targets"`);
        await postgresDb
          .update(trades)
          .set({ status: "waiting_targets" })
          .where(eq(trades.trade_id, String(order.i)));
      }
      break;

    case "order_filled_close":
      if (order.i) {
        console.log(`Closing trade ${order.i}`);
        await postgresDb
          .update(trades)
          .set({
            status: "closed",
            closed_at: new Date(),
          })
          .where(eq(trades.trade_id, String(order.i)));
      }
      break;

    case "order_cancelled":
      if (order.i) {
        console.log(`Cancelling trade ${order.i}`);
        await postgresDb
          .update(trades)
          .set({ status: "cancelled" })
          .where(eq(trades.trade_id, String(order.i)));
      }
      break;

    case "order_partial_fill":
      if (order.i) {
        console.log(`Partial fill for trade ${order.i}`);
        await postgresDb
          .update(trades)
          .set({ status: "partially_filled" })
          .where(eq(trades.trade_id, String(order.i)));
      }
      break;

    default:
      console.log("Order event not handled:", order);
  }

  // Publish to Redis
  await redis.publish(`user:${userId}:orders:chan`, JSON.stringify(order));
}

// ------------------------------------------- //
//       POSITION UPDATE HANDLER
// ------------------------------------------- //

async function handlePositionUpdate(userId: string, msg: any) {
  const positions = msg.a?.P || [];

  console.log(`📥 POSITION UPDATE (${userId}):`, positions);

  for (const position of positions) {
    const positionKey = `${position.s}:${position.ps}`;
    const size = parseFloat(position.pa || "0");

    // Check if position is closed (size = 0)
    if (size === 0) {
      console.log(`Position closed: ${positionKey}`);

      // Find and close trade
      const exchange = await postgresDb.query.exchanges.findFirst({
        columns: { id: true },
        where: eq(exchanges.exchange_user_id, String(userId)),
      });

      if (exchange) {
        await postgresDb
          .update(trades)
          .set({
            status: "closed",
            closed_at: new Date(),
            pnl: position.rp || "0", // Realized PnL
          })
          .where(
            and(
              eq(trades.status, "waiting_targets"),
              eq(trades.contract, position.s),
              eq(trades.exchange_id, exchange.id),
            ),
          );
      }

      // Remove from Redis cache
      await redis.hdel(`user:${userId}:positions`, positionKey);
    } else {
      // Update Redis cache with new position state
      await redis.hset(
        `user:${userId}:positions`,
        positionKey,
        JSON.stringify(position),
      );
    }
  }

  // Publish to Redis
  await redis.publish(`user:${userId}:positions:chan`, JSON.stringify(msg));
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
  const status = order?.X; // Order status
  const filled = parseFloat(order?.z || "0"); // Filled quantity
  const total = parseFloat(order?.q || "0"); // Total quantity
  const reduceOnly = order?.R; // Reduce only flag

  // Fully filled
  if (status === "FILLED") {
    if (reduceOnly) {
      return "order_filled_close";
    }
    return "order_filled_open";
  }

  // Cancelled
  if (status === "CANCELED" || status === "CANCELLED") {
    return "order_cancelled";
  }

  // Partially filled
  if (status === "PARTIALLY_FILLED" || (filled > 0 && filled < total)) {
    return "order_partial_fill";
  }

  return "order_other";
}

// ------------------------------------------- //
//         GRACEFUL SHUTDOWN
// ------------------------------------------- //

process.on("SIGINT", () => {
  console.log("WS Worker: shutting down...");

  for (const [userId, st] of connections.entries()) {
    if (st.ws) st.ws.terminate();
  }
  process.exit(0);
});

console.log("✅ Tokocrypto WebSocket Worker started");
