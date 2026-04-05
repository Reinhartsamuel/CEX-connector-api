/* eslint-disable no-case-declarations */
import WebSocket from "ws";
import Redis from "ioredis";
import JSONbig from "json-bigint";
import { postgresDb } from "../db/client";
import { exchanges, Trade, trades } from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";
import crypto from "crypto";
import { decryptExchangeCreds } from "../utils/cryptography/decryptExchangeCreds";

// ---- Redis Setup ---- //
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const control = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const STREAM_KEY = "ws-control:mexc";
const GROUP_NAME = "mexc-workers";
const CONSUMER_NAME = `mexc-worker-${process.pid}`;

// Each user has exactly one WS connection
interface UserConnection {
  ws: WebSocket | null;
  pingInterval?: NodeJS.Timeout;
  backoff: number;
  contracts: Set<string>;
}
const connections = new Map<string, UserConnection>();

// ---- Redis Streams consumer for ws-control:mexc ---- //
async function startStreamConsumer() {
  try {
    await control.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "$", "MKSTREAM");
    console.log(`[MEXC WS] Created consumer group '${GROUP_NAME}' on stream '${STREAM_KEY}'`);
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
      console.log(`[MEXC WS] Reclaimed ${messages.length} pending message(s) on startup`);
      for (const [id, fields] of messages) {
        await handleStreamMessage(id, fields);
      }
    }
  } catch (err) {
    console.error("[MEXC WS] XAUTOCLAIM failed on startup:", err);
  }

  console.log("[MEXC WS] Listening for control commands via Redis Streams...");
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
      console.error("[MEXC WS] Stream read error:", err);
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
    if (cmd.exchange && cmd.exchange !== "mexc") return;

    if (cmd.op === "open" && cmd.userId) {
      ensureConnection(cmd.userId, cmd.contract ? [cmd.contract] : undefined);
    } else if (cmd.op === "close" && cmd.userId) {
      closeConnection(cmd.userId);
    }

    await control.xack(STREAM_KEY, GROUP_NAME, id);
  } catch (err) {
    console.error("[MEXC WS] Error handling stream message:", id, err);
  }
}

startStreamConsumer().catch((err) => {
  console.error("[MEXC WS] Stream consumer fatal error:", err);
  process.exit(1);
});

// ---- Restore connections for users with active trades on startup ---- //
async function restoreConnections() {
  console.log("[MEXC WS] Restoring connections for users with active trades...");

  try {
    const activeTrades = await postgresDb
      .selectDistinct({ exchange_user_id: exchanges.exchange_user_id })
      .from(trades)
      .innerJoin(exchanges, eq(trades.exchange_id, exchanges.id))
      .where(
        and(
          eq(exchanges.exchange_title, "mexc"),
          inArray(trades.status, ["waiting_position", "partially_filled", "waiting_targets"]),
        ),
      );

    console.log(`[MEXC WS] Found ${activeTrades.length} users with active trades to reconnect`);

    for (const { exchange_user_id } of activeTrades) {
      ensureConnection(exchange_user_id);
    }
  } catch (err) {
    console.error("[MEXC WS] Failed to restore connections on startup:", err);
  }
}

restoreConnections();

// ---- Fetch MEXC credentials via KMS decryption from DB ---- //
async function fetchCreds(userId: string) {
  const creds = await decryptExchangeCreds(userId);
  if (!creds) return null;
  return { apiKey: creds.apiKey, apiSecret: creds.apiSecret };
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

  console.log(`WS Worker: Opening TS for user ${userId}`);

  // MEXC WebSocket endpoint
  const wsUrl = "wss://contract.mexc.com/edge";
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

  // Login first - MEXC uses signature with timestamp
  const reqTime = Date.now().toString();
  const signaturePayload = creds.apiKey + reqTime;
  const signature = crypto
    .createHmac("sha256", creds.apiSecret)
    .update(signaturePayload)
    .digest("hex");

  ws.send(JSON.stringify({
    method: "login",
    param: {
      apiKey: creds.apiKey,
      reqTime,
      signature,
    },
  }));
}

async function onWsMessage(userId: string, raw: Buffer, ws: WebSocket) {
  let msg: any;
  try {
    msg = JSONbig.parse(raw.toString());
  } catch (err) {
    console.error("WS Worker: failed to parse WS message", err);
    return;
  }

  // Handle login response
  if (msg.channel === "rs.login") {
    if (msg.data === "success") {
      console.log(`✅ Login successful for user=${userId}`);
      
      // Subscribe to order channel
      ws.send(JSON.stringify({
        method: "sub.order",
        param: {},
      }));
      
      // Subscribe to position channel
      ws.send(JSON.stringify({
        method: "sub.position",
        param: {},
      }));
      
      console.log(`📡 SUBSCRIBED to orders and positions for user=${userId}`);
    } else {
      console.error(`❌ Login failed for user=${userId}:`, msg);
    }
    return;
  }

  // Handle subscription confirmation
  if (msg.channel === "rs.sub.order" || msg.channel === "rs.sub.position") {
    console.log(`✅ Subscription confirmed for user=${userId}`);
    return;
  }

  // Handle order updates
  if (msg.channel === "push.order") {
    await handleOrderUpdate(userId, msg.data);
    return;
  }

  // Handle position updates
  if (msg.channel === "push.position") {
    await handlePositionUpdate(userId, msg.data);
    return;
  }

  // Handle pong
  if (msg.channel === "rs.ping") {
    console.log(`🏓 PONG ← user=${userId}`);
    return;
  }
}

function onWsClose(userId: string, code: number, reason: Buffer) {
  console.warn(
    `WS Worker: WS CLOSED user=${userId} code=${code} reason=${reason.toString()}`,
  );

  const state = connections.get(userId);
  if (!state) return;

  if (state.pingInterval) clearInterval(state.pingInterval);

  state.ws = null;
  connections.delete(userId);

  const delay = state.backoff;
  state.backoff = Math.min(state.backoff * 1.5, 60_000);

  console.log(`WS Worker: Reconnecting user ${userId} in ${delay}ms...`);

  setTimeout(() => ensureConnection(userId), delay);
}

// ------------------------------------------- //
//         ORDER UPDATE HANDLER
// ------------------------------------------- //

async function handleOrderUpdate(userId: string, data: any) {
  const orders = Array.isArray(data) ? data : [data];
  
  for (const order of orders) {
    const event = classifyOrderEvent(order);
    console.log(`📥 ORDER UPDATE (${userId}): event=${event}`, order);

    let tradeData: Trade | null = null;
    if (order?.orderId) {
      try {
        const [row] = await postgresDb
          .select()
          .from(trades)
          .where(eq(trades.trade_id, String(order.orderId)));
        tradeData = row;
      } catch (e) {
        console.error(e, "error query");
      }
    }

    switch (event) {
      case "order_filled_open":
        if (order.orderId) {
          await postgresDb
            .update(trades)
            .set({
              status: "waiting_targets",
              open_fill_price: order.dealAvgPrice || order.price,
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
        console.log("Order event not handled:", order);
    }

    await redis.publish(`user:${userId}:orders:chan`, JSON.stringify(order));
  }
}

// ------------------------------------------- //
//       POSITION UPDATE HANDLER
// ------------------------------------------- //

async function handlePositionUpdate(userId: string, data: any) {
  const positions = Array.isArray(data) ? data : [data];
  
  for (const position of positions) {
    const symbol = position.symbol;
    const posSide = position.positionType; // long or short
    const size = parseFloat(position.holdQty || "0");
    const positionKey = `${symbol}:${posSide}`;

    console.log(`📥 POSITION UPDATE (${userId}): ${positionKey}, size=${size}`);

    if (size === 0) {
      // Position closed
      console.log(`Position closed: ${positionKey}`);

      const exchange = await postgresDb.query.exchanges.findFirst({
        columns: { id: true },
        where: eq(exchanges.exchange_user_id, String(userId)),
      });

      if (exchange) {
        const unrealizedPnl = position.unrealizedPnl || "0";
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

  await redis.publish(`user:${userId}:positions:chan`, JSON.stringify(positions));
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
  const status = order?.status; // 1=pending, 2=partial-fill, 3=filled, 4=cancelled
  const filledQty = parseFloat(order?.dealAmount || "0");
  const totalQty = parseFloat(order?.amount || "0");
  const reduceOnly = order?.reduceOnly === true;

  if (status === 3 || (filledQty > 0 && filledQty >= totalQty)) {
    if (reduceOnly) {
      return "order_filled_close";
    }
    return "order_filled_open";
  }

  if (status === 4) {
    return "order_cancelled";
  }

  if (status === 2 || (filledQty > 0 && filledQty < totalQty)) {
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

console.log("✅ MEXC WebSocket Worker started");