/* eslint-disable no-case-declarations */
import WebSocket from "ws";
import Redis from "ioredis";
import JSONbig from "json-bigint";
import { postgresDb } from "../db/client";
import { exchanges, Trade, trades } from "../db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { signWebSocketRequest, signRequestRestGate } from "../utils/authentication/signRequestGate";
import { publishWsReady } from "../utils/wsReady";
import { decryptExchangeCreds } from "../utils/cryptography/decryptExchangeCreds";

const GATE_BASE_URL = "https://api.gateio.ws";

// ---- Redis Setup ---- //
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const control = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const STREAM_KEY = "ws-control:gate";
const GROUP_NAME = "gate-workers";
const CONSUMER_NAME = `gate-worker-${process.pid}`;

// Each user has exactly one WS connection.
interface UserConnection {
  ws: WebSocket | null;
  pingInterval?: NodeJS.Timeout;
  backoff: number;
  contracts: Set<string>; // dynamic list of contracts user wants
}
const connections = new Map<string, UserConnection>();

// ---- Redis Streams consumer for ws-control:gate ---- //
async function startStreamConsumer() {
  // Create consumer group if it doesn't exist (idempotent)
  try {
    await control.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "$", "MKSTREAM");
    console.log(`[Gate WS] Created consumer group '${GROUP_NAME}' on stream '${STREAM_KEY}'`);
  } catch (err: any) {
    if (!err.message?.includes("BUSYGROUP")) throw err;
    // Group already exists — expected on restart
  }

  // On startup: reclaim messages pending > 30s from a crashed previous instance
  try {
    const claimed = await (control as any).xautoclaim(
      STREAM_KEY, GROUP_NAME, CONSUMER_NAME,
      30_000, "0-0", "COUNT", "100",
    );
    const messages = Array.isArray(claimed) ? (claimed[1] ?? []) : [];
    if (messages.length > 0) {
      console.log(`[Gate WS] Reclaimed ${messages.length} pending message(s) on startup`);
      for (const [id, fields] of messages) {
        await handleStreamMessage(id, fields);
      }
    }
  } catch (err) {
    console.error("[Gate WS] XAUTOCLAIM failed on startup:", err);
  }

  // Main read loop
  console.log("[Gate WS] Listening for control commands via Redis Streams...");
  while (true) {
    try {
      const results = await control.xreadgroup(
        "GROUP", GROUP_NAME, CONSUMER_NAME,
        "COUNT", "10",
        "BLOCK", "5000",
        "STREAMS", STREAM_KEY, ">",
      ) as any;

      if (!results) continue; // timeout, no new messages

      for (const [, messages] of results) {
        for (const [id, fields] of messages) {
          await handleStreamMessage(id, fields);
        }
      }
    } catch (err) {
      console.error("[Gate WS] Stream read error:", err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function parseStreamFields(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

async function handleStreamMessage(id: string, fields: string[]) {
  try {
    const cmd = parseStreamFields(fields);

    if (cmd.op === "open" && cmd.userId) {
      ensureConnection(cmd.userId, cmd.contract ? [cmd.contract] : undefined);
    } else if (cmd.op === "close" && cmd.userId) {
      closeConnection(cmd.userId);
    }

    await control.xack(STREAM_KEY, GROUP_NAME, id);
  } catch (err) {
    console.error("[Gate WS] Error handling stream message:", id, err);
    // Do not ACK — message remains pending and will be reclaimed on next startup
  }
}

startStreamConsumer().catch((err) => {
  console.error("[Gate WS] Stream consumer fatal error:", err);
  process.exit(1);
});

// ---- Restore connections for users with active trades on startup ---- //
async function restoreConnections() {
  console.log("[Gate WS] Restoring connections for users with active trades...");

  try {
    const activeTrades = await postgresDb
      .selectDistinct({ exchange_user_id: exchanges.exchange_user_id })
      .from(trades)
      .innerJoin(exchanges, eq(trades.exchange_id, exchanges.id))
      .where(
        and(
          eq(exchanges.exchange_title, "gate"),
          inArray(trades.status, ["waiting_position", "partially_filled", "waiting_targets"]),
        ),
      );

    console.log(`[Gate WS] Found ${activeTrades.length} users with active trades to reconnect`);

    for (const { exchange_user_id } of activeTrades) {
      ensureConnection(exchange_user_id);
    }
  } catch (err) {
    console.error("[Gate WS] Failed to restore connections on startup:", err);
  }
}

restoreConnections();

// ---- Fetch Gate credentials via KMS decryption from DB ---- //
async function fetchCreds(userId: string) {
  const creds = await decryptExchangeCreds(userId);
  if (!creds) return null;
  return { apiKey: creds.apiKey, apiSecret: creds.apiSecret };
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
    // Still publish ready so the executor waiting on ws-ready doesn't hang
    publishWsReady(redis, "gate", userId).catch(() => {});
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

  // == Signal that WS is ready so executors can proceed with order placement ==
  publishWsReady(redis, "gate", userId).catch((err) =>
    console.error(`WS Worker: failed to publish ws-ready for user ${userId}:`, err),
  );

  // == Run snapshot reconciliation after subscribing ==
  reconcileSnapshot(userId, creds).catch((err) =>
    console.error(`WS Worker: reconciliation failed for user ${userId}:`, err),
  );

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
    // console.log(`📥 ORDERS UPDATE (${userId}):`, JSON.stringify(msg, null, 2));

    // Handle order updates inside a transaction for atomicity
    await postgresDb.transaction(async (tx) => {
      for (const item of items) {
        const event = classifyOrderEvent(item);
        console.log("[Gate WS] classified order event:", event);
        if (event === "subscribe_ack") continue;

        let tradeData: Trade | null = null;
        if (item?.id || item?.id_string) {
          try {
            const [row] = await tx
              .select()
              .from(trades)
              .where(eq(trades.trade_id, item.id_string));
            tradeData = row;
          } catch (e) {
            console.error(e, "error query");
          }
        }

        if (item.id_string) {
          switch (event) {
            case "order_filled_open":
              console.log(`[Gate WS] Order ${item.id_string} filled → waiting_targets`);
              await tx
                .update(trades)
                .set({
                  status: "waiting_targets",
                  open_fill_price: item.fill_price ?? item.price,
                  open_filled_at: item.finish_time ? Number(item.finish_time) : undefined,
                })
                .where(eq(trades.trade_id, item.id_string));
              break;

            case "order_filled_close":
              console.log(`[Gate WS] Close order ${item.id_string} filled`);
              if (tradeData) {
                await tx
                  .update(trades)
                  .set({
                    close_order_id: item.id_string,
                    close_fill_price: item.fill_price ?? item.price,
                    close_filled_at: item.finish_time ? Number(item.finish_time) : undefined,
                  })
                  .where(eq(trades.trade_id, tradeData.trade_id));
              }
              break;

            case "order_partial_fill":
              await tx
                .update(trades)
                .set({ status: "partially_filled" })
                .where(eq(trades.trade_id, item.id_string));
              break;

            default:
              console.log("[Gate WS] Order event not handled:", event, item.id_string);
          }
        } else {
          console.log("[Gate WS] Order update missing id_string, skipping");
        }

        await redis.publish(`user:${userId}:orders:chan`, JSON.stringify(item));
      }
    });
  }

  if (channel === "futures.positions") {
    console.log(
      `📥 POSITIONS UPDATE (${userId}):`,
      JSON.stringify(msg, null, 2),
    );
    // Handle position updates
    await Promise.all(
      items.map(async (item: any) => {
        await handlePositionItem(userId, item);

        // store current position
        // const positionId = String(item.id ?? item.position_id ?? item.contract ?? "unknown");
        // await redis.hset(`user:${userId}:positions`, positionId, JSON.stringify(item));

        await redis.publish(
          `user:${userId}:positions:chan`,
          JSON.stringify(item),
        );
      }),
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

// ------------------------------------------- //
//        SNAPSHOT RECONCILIATION
// ------------------------------------------- //

/**
 * After WS subscribes, poll REST API to catch any order/position changes
 * that happened before the WS connection was established (race condition fix).
 *
 * 1. Find all DB trades for this exchange_user_id in transient states
 * 2. For each "waiting_position"/"partially_filled" trade → check order via REST
 * 3. For "waiting_targets" trades → check if position is already closed via REST
 */
async function reconcileSnapshot(
  userId: string,
  creds: { apiKey: string; apiSecret: string },
) {
  console.log(`[Reconcile] Starting snapshot reconciliation for user ${userId}`);

  // Find the exchange record for this user
  const exchange = await postgresDb.query.exchanges.findFirst({
    columns: { id: true },
    where: eq(exchanges.exchange_user_id, userId),
  });
  if (!exchange) {
    console.warn(`[Reconcile] No exchange record for exchange_user_id=${userId}`);
    return;
  }

  // ---- Phase 1: Reconcile pending orders (waiting_position / partially_filled) ----
  const pendingTrades = await postgresDb
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.exchange_id, exchange.id),
        inArray(trades.status, ["waiting_position", "partially_filled"]),
      ),
    );

  console.log(`[Reconcile] Found ${pendingTrades.length} pending trades to check for user ${userId}`);

  // Fetch all order statuses from REST first, then apply updates in a single transaction
  const pendingUpdates: Array<{ trade: typeof pendingTrades[0]; event: OrderEvent; orderData: any }> = [];

  for (const trade of pendingTrades) {
    try {
      const orderData = await gateRestGetOrder(creds, trade.trade_id);
      if (!orderData || orderData.status === "error") {
        console.warn(`[Reconcile] Failed to fetch order ${trade.trade_id}:`, orderData);
        continue;
      }

      const event = classifyOrderEvent(orderData);
      console.log(`[Reconcile] Order ${trade.trade_id} REST status: ${event}`);
      pendingUpdates.push({ trade, event, orderData });
    } catch (err) {
      console.error(`[Reconcile] Error checking order ${trade.trade_id}:`, err);
    }
  }

  if (pendingUpdates.length > 0) {
    await postgresDb.transaction(async (tx) => {
      for (const { trade, event, orderData } of pendingUpdates) {
        if (event === "order_filled_open") {
          await tx
            .update(trades)
            .set({
              status: "waiting_targets",
              open_fill_price: orderData.fill_price ?? orderData.price,
              open_filled_at: orderData.finish_time ? Number(orderData.finish_time) : undefined,
            })
            .where(eq(trades.id, trade.id));
          console.log(`[Reconcile] Trade ${trade.id} updated to waiting_targets (was ${trade.status})`);
        } else if (event === "order_filled_close") {
          await tx
            .update(trades)
            .set({ status: "closed", closed_at: new Date() })
            .where(eq(trades.id, trade.id));
          console.log(`[Reconcile] Trade ${trade.id} updated to closed (reduce-only fill)`);
        } else if (event === "order_cancelled") {
          await tx
            .update(trades)
            .set({ status: "cancelled", cancelled_at: new Date() })
            .where(eq(trades.id, trade.id));
          console.log(`[Reconcile] Trade ${trade.id} updated to cancelled`);
        }
      }
    });
  }

  // ---- Phase 2: Reconcile open positions (waiting_targets → closed?) ----
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
    console.log(`[Reconcile] No waiting_targets trades to check for user ${userId}`);
    return;
  }

  // Fetch all current positions from Gate REST
  const positions = await gateRestGetPositions(creds);
  if (!positions || positions.status === "error") {
    console.warn(`[Reconcile] Failed to fetch positions for user ${userId}:`, positions);
    return;
  }

  // Build a set of contracts that have an open position (size != 0)
  const openPositionContracts = new Set<string>();
  for (const pos of Array.isArray(positions) ? positions : []) {
    if (Number(pos.size ?? 0) !== 0) {
      openPositionContracts.add(pos.contract);
    }
  }

  console.log(`[Reconcile] Open position contracts: [${[...openPositionContracts].join(", ")}]`);

  // Collect closed trades and their PnL from REST, then batch-update in a transaction
  const closedUpdates: Array<{ trade: typeof waitingTrades[0]; pnl: string }> = [];

  for (const trade of waitingTrades) {
    if (!openPositionContracts.has(trade.contract)) {
      console.log(`[Reconcile] Trade ${trade.id} (${trade.contract}) has no open position — marking closed`);

      let pnl = "0";
      try {
        const orderData = await gateRestGetOrder(creds, trade.trade_id);
        pnl = orderData?.realised_pnl ?? "0";
      } catch {
        // If REST fails, still mark closed but with 0 PnL
      }

      closedUpdates.push({ trade, pnl });
    }
  }

  if (closedUpdates.length > 0) {
    await postgresDb.transaction(async (tx) => {
      for (const { trade, pnl } of closedUpdates) {
        await tx
          .update(trades)
          .set({
            status: "closed",
            closed_at: new Date(),
            pnl,
          })
          .where(eq(trades.id, trade.id));
      }
    });

    // Clean up Redis position cache after DB transaction succeeds
    for (const { trade } of closedUpdates) {
      const mode = trade.position_type === "long" ? "dual_long" : "dual_short";
      const positionKey = `${trade.contract}:${mode}`;
      await redis.hdel(`user:${userId}:positions`, positionKey);
    }
  }

  console.log(`[Reconcile] Snapshot reconciliation complete for user ${userId}`);
}

// ---- Gate REST helpers for reconciliation (avoids singleton GateServices state issue) ----

async function gateRestGetOrder(
  creds: { apiKey: string; apiSecret: string },
  orderId: string,
) {
  const urlPath = `/api/v4/futures/usdt/orders/${orderId}`;
  const headers = signRequestRestGate(
    { key: creds.apiKey, secret: creds.apiSecret },
    { method: "GET", urlPath, queryString: "" },
  );

  const response = await fetch(`${GATE_BASE_URL}${urlPath}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", ...headers },
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { status: "error" as const, message: errorText, statusCode: response.status };
  }

  const responseText = await response.text();
  return JSONbig.parse(responseText);
}

async function gateRestGetPositions(creds: { apiKey: string; apiSecret: string }) {
  const urlPath = "/api/v4/futures/usdt/positions";
  const headers = signRequestRestGate(
    { key: creds.apiKey, secret: creds.apiSecret },
    { method: "GET", urlPath, queryString: "", payload: "" },
  );

  const response = await fetch(`${GATE_BASE_URL}${urlPath}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", ...headers },
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { status: "error" as const, message: errorText, statusCode: response.status };
  }

  const responseText = await response.text();
  return JSONbig.parse(responseText);
}

// --------------------- helper types ---------------------
type OrderItem = any;
type PositionItem = any;

type OrderEvent =
  | "subscribe_ack"
  | "order_partial_fill"
  | "order_filled_open" // filled and opened a position (is_reduce_only=false)
  | "order_filled_close" // filled and closed (is_reduce_only=true)
  | "order_cancelled"
  | "order_other";

type PositionEvent =
  | "position_opened"
  | "position_changed"
  | "position_closed"
  | "position_heartbeat"
  | "unknown";

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
  // const role = item?.role ?? "";
  const size = Number(item?.size ?? 0);

  if (status === "finished" && finish === "filled" && left === 0) {
    if (isReduce) return "order_filled_close";
    return "order_filled_open";
  }

  if (
    (status === "finished" && finish === "cancelled") ||
    finish === "cancelled"
  ) {
    return "order_cancelled";
  }

  if (left > 0 && left < Math.abs(size || 0)) return "order_partial_fill";

  return "order_other";
}

function classifyPositionEvent(
  item: PositionItem,
  prev?: PositionItem,
): PositionEvent {
  const newSize = Number(item?.size ?? 0);
  const prevSize = prev ? Number(prev.size ?? 0) : 0;

  console.log("===========classifyPositionEvent===========");
  console.log("===========classifyPositionEvent===========");
  console.log("===========classifyPositionEvent===========");
  console.log("===========classifyPositionEvent===========");
  console.log(`prevSize: ${prevSize}, newSize: ${newSize}`);
  console.log("===========classifyPositionEvent===========");
  console.log("===========classifyPositionEvent===========");
  console.log("===========classifyPositionEvent===========");
  console.log("===========classifyPositionEvent===========");

  if (prev === undefined && newSize !== 0) return "position_opened";
  if (prev !== undefined && newSize === 0 && prevSize !== 0)
    return "position_closed";
  if (prev !== undefined && newSize !== prevSize) return "position_changed";

  return "unknown";
}

async function handlePositionItem(userId: string, item: any) {
  console.log(
    `🚗🚗🚗🚗🚗🚗🚗 item: ${JSON.stringify(item)}, please ignore if undefined ${item == undefined}`,
  );
  if (item?.status === "success") {
    console.log(
      `NGECEK ITEM STATUS SUCCESS NGGAK ${JSON.stringify(item)}, :::::: item?.status === 'success'????? ::::${item?.status === "success"}`,
    );
    return;
  }
  // compute a convenient key (contract:mode) same as when you save
  const mode = item.mode ?? item.position_side ?? "";
  const positionKey = `${item.contract}:${mode}`;

  // fetch previous position exposure (if any)
  const prevRaw = await redis.hget(`user:${userId}:positions`, positionKey);
  const prev = prevRaw ? JSON.parse(prevRaw) : undefined;
  // const exchange = await postgresDb.query.exchanges.findFirst({
  //   columns: {
  //     id: true,  // Only select the id column
  //   },
  //   where:eq(exchanges.exchange_user_id, item.user),
  //   });

  // const prev = await postgresDb.query.trades.findFirst({
  //   columns: {
  //     id: true,  // Only select the id column
  //     size:true,
  //     contract:true,
  //     order_id:true,
  //   },
  //   where: and(
  //     eq(trades.status, 'waiting_targets'),
  //     eq(trades.contract, item.contract),
  //     eq(trades.exchange_id, exchange!.id),
  //   ),
  //   orderBy: desc(trades.created_at),
  // });

  console.log(
    `🚀🚀🚀🚀🚀🚀🚀🚀 getting previous position data for user:${userId}:positions positionKey: ${positionKey}: ${JSON.stringify(prev, null, 2)}🚀🚀🚀🚀🚀🚀🚀🚀`,
  );

  const event = classifyPositionEvent(item, prev);
  console.log("🧭 position event:", event, "for", positionKey);

  // now business logic
  switch (event) {
    case "position_opened":
    case "position_changed":
      // Always update cache & publish (so UI & other services get the raw payload)
      await redis.hset(
        `user:${userId}:positions`,
        positionKey,
        JSON.stringify(item),
      );
      await redis.publish(
        `user:${userId}:positions:chan`,
        JSON.stringify(item),
      );
      break;

    case "position_closed":
      const exchange = await postgresDb.query.exchanges.findFirst({
        columns: { id: true },
        where: eq(exchanges.exchange_user_id, String(item.user)),
      });

      if (!exchange) {
        console.warn(`[Gate WS] No exchange record for user ${item.user} — skipping position_closed update`);
        await redis.hdel(`user:${userId}:positions`, positionKey);
        break;
      }

      // Find all waiting_targets trades for this contract — need to distribute PnL by size
      const matchingTrades = await postgresDb
        .select({ id: trades.id, size: trades.size })
        .from(trades)
        .where(
          and(
            eq(trades.status, "waiting_targets"),
            eq(trades.contract, item.contract),
            eq(trades.exchange_id, exchange.id),
          ),
        );

      if (matchingTrades.length === 0) {
        console.warn(`[Gate WS] Position closed for ${item.contract} but no matching waiting_targets trade found`);
        await redis.hdel(`user:${userId}:positions`, positionKey);
        break;
      }

      const totalPnl = parseFloat(item.realised_pnl ?? "0");
      const totalSize = matchingTrades.reduce((sum: number, t: { size: string | null }) => sum + Math.abs(parseFloat(t.size ?? "0")), 0);
      const now = new Date();

      await postgresDb.transaction(async (tx) => {
        for (const trade of matchingTrades) {
          // Distribute PnL proportionally by size
          const tradeSize = Math.abs(parseFloat(trade.size ?? "0"));
          const tradePnl = totalSize > 0 ? (tradeSize / totalSize) * totalPnl : 0;

          await tx
            .update(trades)
            .set({
              status: "closed",
              closed_at: now,
              pnl: tradePnl.toString(),
            })
            .where(eq(trades.id, trade.id));
        }
      });

      console.log(`[Gate WS] Position closed — updated ${matchingTrades.length} trade(s) for ${item.contract}, total PnL=${totalPnl}`);

      await redis.hdel(`user:${userId}:positions`, positionKey);
      break;

    case "unknown":
      // keep-alive / update only PnL; optional DB update
      break;
  }
}
