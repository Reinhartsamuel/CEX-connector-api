import WebSocket from "ws";
import Redis from "ioredis";
import JSONbig from "json-bigint";
import { signWebSocketRequest } from "../utils/signRequest";
import { postgresDb } from "../db/client";
import { Trade, trades } from "../db/schema";
import { eq } from "drizzle-orm";

// ---- Redis Setup ---- //
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const control = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const CTRL_CHANNEL = "ws-control";

// Each user has exactly one WS connection.
interface UserConnection {
  ws: WebSocket | null;
  pingInterval?: NodeJS.Timeout;
  backoff: number;
  contracts: Set<string>; // dynamic list of contracts user wants
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

// ---- Fetch Gate credentials from Redis ---- //
async function fetchCreds(userId: string) {
  const data = await redis.hgetall(`gate:creds:${userId}`);
  if (!data || !data.apiKey || !data.apiSecret) return null;
  return { apiKey: data.apiKey, apiSecret: data.apiSecret };
}

// ---- Build WebSocket auth payload ---- //
// Gate WS authentication format
async function buildAuth(apiKey: string, apiSecret: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signaturePayload = `${timestamp}\n`;

  const crypto = await import("crypto");
  const sign = crypto
    .createHmac("sha512", apiSecret)
    .update(signaturePayload)
    .digest("hex");

  return {
    method: "api_key",
    KEY: apiKey,
    SIGN: sign,
    timestamp,
  };
}

// ------------------------------------------- //
//       MAIN CONNECTION MANAGEMENT
// ------------------------------------------- //

async function ensureConnection(
  userId: string,
  contractList: string[] = ["!all"],
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

  const wsUrl = "wss://fx-ws.gateio.ws/v4/ws/usdt";
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

  const authOrders = signWebSocketRequest(
    {
      key: creds ? creds.apiKey : "",
      secret: creds ? creds.apiSecret : "",
    },
    {
      channel: "futures.orders",
      event: "subscribe",
      timestamp: Math.floor(Date.now() / 1000),
    },
  );
  // == SUBSCRIBE TO ORDERS ==
  ws.send(
    JSON.stringify({
      time: Math.floor(Date.now() / 1000),
      channel: "futures.orders",
      event: "subscribe",
      auth: authOrders,
      payload: [userId, "!all"],
    }),
  );
  console.log(`📡 SUBSCRIBED (ORDERS) user=${userId}`);

  const authPositions = signWebSocketRequest(
    {
      key: creds ? creds.apiKey : "",
      secret: creds ? creds.apiSecret : "",
    },
    {
      channel: "futures.positions",
      event: "subscribe",
      timestamp: Math.floor(Date.now() / 1000),
    },
  );
  // == SUBSCRIBE TO POSITIONS ==
  ws.send(
    JSON.stringify({
      time: Math.floor(Date.now() / 1000),
      channel: "futures.positions",
      event: "subscribe",
      auth: authPositions,
      payload: [userId, "!all"],
    }),
  );
  console.log(`📡 SUBSCRIBED (POSITIONS) user=${userId}`);

  // == Setup ping interval ==
  if (state.pingInterval) clearInterval(state.pingInterval);

  state.pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          time: Math.floor(Date.now() / 1000),
          channel: "futures.ping",
          event: "ping",
        }),
      );
      console.log(`🏓 PING → user=${userId}`);
    }
  }, 25_000); // must be ≤ 30s for Gate
}

async function onWsMessage(userId: string, raw: Buffer) {
  let msg: any;
  try {
    msg = JSONbig.parse(raw.toString());
  } catch (err) {
    console.error("WS Worker: failed to parse WS message", err);
    return;
  }

  const channel = msg?.channel;

  const payload = msg?.result;
  if (!payload) return;
  // payload might be a single order or array
  const items = Array.isArray(payload) ? payload : [payload];

  if (channel === "futures.pong") {
    console.log(`🏓 PONG ← user=${userId}`);
    return;
  }

  if (channel === "futures.orders") {
    console.log(`📥 ORDERS UPDATE (${userId}):`, JSON.stringify(msg, null, 2));
    const id = payload.id_string || String(payload.id);

    // Handle order updates
    await Promise.all(
      items.map(async (item: any) => {
        const event = classifyOrderEvent(item);
        console.log("🤮🤮🤮🤮🤮🤮classified order event:", event);
        if (event === 'subscribe_ack') return;

        console.log(`getting trades with trade.id: ${item.id ?? item.id_string}`)
        let tradeData: Trade | null = null;
        if (item?.id || item?.id_string) {
          try {
            const [row] = await postgresDb
              .select()
              .from(trades)
              .where(eq(trades.trade_id, item.id ?? item.id_string));
            tradeData = row
          } catch (e) {
            console.error(e, 'error query')
          }
        }
        // ========================EVENT HANDLING========================
        // ========================EVENT HANDLING========================
        // ========================EVENT HANDLING========================
        if (item.id_string) {
          switch (event) {
            case "order_filled_open":
              // update DB trade -> waiting_targets (your current logic)
              // but also _do not_ consider position > open until positions.update arrives;
              // mark trade as filled_at: item.finish_time / fill_price, then wait for positions update.
              console.log(`updating trade id ${item.id_string} to "waiting_targets"`);
              await postgresDb.update(trades).set({ status: "waiting_targets" }).where(eq(trades.trade_id, item.id_string));
              console.log(
                "trade Data::::: please handle TP/SL",
                JSON.stringify(tradeData, null, 2),
              );
              break;

            case "order_filled_close":
              // this is a close-order filled (could be manual close or API close).
              // mark DB trade as closed (or add a 'closed_by' field with order id)
              console.log(`updating trade id ${item.id_string} to "closed"`);
              await postgresDb.update(trades).set({ status: "closed" }).where(eq(trades.trade_id, item.linked_open_order_id ?? item.related_id ?? item.id_string));
              break;

            case "order_partial_fill":
              // set status partially_filled and update left
              console.log(`updating trade id ${item.id_string} to "partially_filled"`);
              await postgresDb.update(trades).set({ status: "partially_filled" }).where(eq(trades.trade_id, item.id_string));
              break;

            default:
              // log for debugging
              console.log("order event not handled:", item);
          }
        } else {
          console.log('🙏🙏🙏🙏 no trade.id_string')
        }
        //================================================================
        //================================================================
        //================================================================
        //================================================================
        //================================================================


        const orderId = String(
          item.id_string ?? item.order_id ?? item.trade_id ?? "unknown",
        );
        await redis.hset(
          `user:${userId}:orders`,
          orderId,
          JSON.stringify(item),
        );
        await redis.publish(`user:${userId}:orders:chan`, JSON.stringify(item));
      }),
    );
  }

  if (channel === "futures.positions") {
    console.log(
      `📥 POSITIONS UPDATE (${userId}):`,
      JSON.stringify(msg, null, 2),
    );
    // Handle position updates
    await Promise.all(
      items.map(async (item: any) => {
        const positionId = String(item.id ?? item.position_id ?? item.contract ?? "unknown");

        await handlePositionItem(userId, item);
        await redis.hset(`user:${userId}:positions`, positionId, JSON.stringify(item));
        await redis.publish(`user:${userId}:positions:chan`, JSON.stringify(item));
      })
    );
  }
}

function onWsClose(userId: string, code: number, reason: Buffer) {
  console.warn(
    `WS Worker: WS CLOSED user=${userId} code=${code} reason=${reason.toString()}`,
  );

  const state = connections.get(userId);
  if (!state) return;

  if (state.pingInterval) clearInterval(state.pingInterval);

  // delete stale ws
  state.ws = null;
  connections.delete(userId);

  // schedule reconnect
  const delay = state.backoff;
  state.backoff = Math.min(state.backoff * 1.5, 60_000);

  console.log(`WS Worker: Reconnecting user ${userId} in ${delay}ms...`);

  setTimeout(() => ensureConnection(userId), delay);
}

// ------------------------------------------- //
//          CLOSE USER CONNECTION
// ------------------------------------------- //

function closeConnection(userId: string) {
  console.log(`WS Worker: Closing WS for user ${userId}`);

  const st = connections.get(userId);
  if (!st) return;

  if (st.pingInterval) clearInterval(st.pingInterval);

  if (st.ws && st.ws.readyState === WebSocket.OPEN) {
    st.ws.close();
  }

  connections.delete(userId);
}

// ------------------------------------------- //
//             GRACEFUL SHUTDOWN
// ------------------------------------------- //

process.on("SIGINT", () => {
  console.log("WS Worker: shutting down...");

  for (const [userId, st] of connections.entries()) {
    if (st.ws) st.ws.terminate();
  }
  process.exit(0);
});



// --------------------- helper types ---------------------
type OrderItem = any;
type PositionItem = any;

type OrderEvent =
  | "subscribe_ack"
  | "order_partial_fill"
  | "order_filled_open"        // filled and opened a position (is_reduce_only=false)
  | "order_filled_close"       // filled and closed (is_reduce_only=true)
  | "order_cancelled"
  | "order_other";

type PositionEvent =
  | "position_opened"
  | "position_changed"
  | "position_closed"
  | "position_heartbeat";

// --------------------- classifier helpers ---------------------
function classifyOrderEvent(item: OrderItem): OrderEvent {
  // subscribe ack
  if (item?.status === "success" && item?.result === undefined) {
    return "subscribe_ack";
  }

  const finish = item?.finish_as ?? null; // "filled", "cancelled", ...
  const left = Number(item?.left ?? 0);
  const status = item?.status ?? null; // "finished" or "success"
  const isReduce = Boolean(item?.is_reduce_only || item?.is_close);
  const role = item?.role ?? "";
  const size = Number(item?.size ?? 0);

  if (status === "finished" && finish === "filled" && left === 0) {
    if (isReduce) return "order_filled_close";
    return "order_filled_open";
  }

  if ((status === "finished" && finish === "cancelled") || finish === "cancelled") {
    return "order_cancelled";
  }

  if (left > 0 && left < Math.abs(size || 0)) return "order_partial_fill";

  return "order_other";
}

function classifyPositionEvent(item: PositionItem, prev?: PositionItem): PositionEvent {
  const newSize = Number(item?.size ?? 0);
  const prevSize = prev ? Number(prev.size ?? 0) : 0;

  if (prev === undefined && newSize !== 0) return "position_opened";
  if (prev !== undefined && newSize === 0 && prevSize !== 0) return "position_closed";
  if (prev !== undefined && newSize !== prevSize) return "position_changed";

  return "position_heartbeat";
}

async function handlePositionItem(userId: string, item: any) {
  // compute a convenient key (contract:mode) same as when you save
  const mode = item.mode ?? item.position_side ?? "";
  const positionKey = `${item.contract}:${mode}`;

  // fetch previous cached version (if any)
  let prevRaw = await redis.hget(`user:${userId}:positions`, positionKey);
  let prev = prevRaw ? JSON.parse(prevRaw) : undefined;

  const event = classifyPositionEvent(item, prev);
  console.log("🧭 position event:", event, "for", positionKey);

  // Always update cache & publish (so UI & other services get the raw payload)
  await redis.hset(`user:${userId}:positions`, positionKey, JSON.stringify(item));
  await redis.publish(`user:${userId}:positions:chan`, JSON.stringify(item));

  // now business logic
  switch (event) {
    case "position_opened":
      break;

    case "position_changed":
      // size changed (user added/removed or partial fills)
      break;

    case "position_closed":
      break;

    case "position_heartbeat":
      // keep-alive / update only PnL; optional DB update
      break;
  }
}
