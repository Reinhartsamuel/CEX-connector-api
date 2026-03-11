import WebSocket from "ws";
import Redis from "ioredis";
import { postgresDb } from "../db/client";
import { exchanges, trades } from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { signRequestOkxWs, signRequestOkx } from "../utils/authentication/signRequestOkx";
import { publishWsReady } from "../utils/wsReady";
import { decryptExchangeCreds } from "../utils/cryptography/decryptExchangeCreds";

// ---- Redis Setup ---- //
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const control = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const CTRL_CHANNEL = "ws-control";
const OKX_BASE_URL = "https://www.okx.com";

// Each user has exactly one WS connection.
interface OkxConnection {
  ws: WebSocket | null;
  pingInterval?: NodeJS.Timeout;
  backoff: number;
  loggedIn: boolean;
}
const connections = new Map<string, OkxConnection>();

// ---- Subscribe to control channel ---- //
(async () => {
  console.log("OKX WS Worker: Listening for control commands...");
  await control.subscribe(CTRL_CHANNEL);

  control.on("message", (chan, msg) => {
    if (chan !== CTRL_CHANNEL) return;

    try {
      const cmd = JSON.parse(msg);

      // Only handle OKX commands (exchange field distinguishes from Gate/Hyperliquid)
      if (cmd.exchange !== "okx") return;

      if (cmd.op === "open" && cmd.userId) {
        ensureConnection(cmd.userId);
      }

      if (cmd.op === "close" && cmd.userId) {
        closeConnection(cmd.userId);
      }
    } catch (err) {
      console.error("OKX WS Worker: invalid control command:", msg, err);
    }
  });
})();

// ---- Restore connections for users with active trades on startup ---- //
async function restoreConnections() {
  console.log("[OKX WS] Restoring connections for users with active trades...");

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

    console.log(`[OKX WS] Found ${activeTrades.length} users with active trades to reconnect`);

    for (const { exchange_user_id } of activeTrades) {
      ensureConnection(exchange_user_id);
    }
  } catch (err) {
    console.error("[OKX WS] Failed to restore connections on startup:", err);
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
    console.log(`OKX WS Worker: connection already open for user ${userId}`);
    publishWsReady(redis, "okx", userId).catch(() => {});
    return;
  }

  const creds = await fetchCreds(userId);
  if (!creds) {
    console.warn(`OKX WS Worker: No credentials found for user ${userId}`);
    return;
  }

  console.log(`OKX WS Worker: Opening WS for user ${userId}`);

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
  ws.on("error", (err) =>
    console.error(`OKX WS Worker: WS error (${userId})`, err),
  );
}

// ------------------------------------------- //
//             EVENT HANDLERS
// ------------------------------------------- //

function onWsOpen(
  userId: string,
  ws: WebSocket,
  creds: { apiKey: string; apiSecret: string; passphrase: string },
) {
  console.log(`OKX WS Worker: WS OPEN for user ${userId}`);

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
  console.log(`OKX WS Worker: LOGIN sent for user ${userId}`);

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
    console.error("OKX WS Worker: failed to parse WS message", err);
    return;
  }

  // Handle login response
  if (msg.event === "login") {
    if (msg.code === "0") {
      console.log(`OKX WS Worker: LOGIN SUCCESS for user ${userId}`);

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
        console.log(`OKX WS Worker: SUBSCRIBED (orders+positions) user=${userId}`);
      }

      // Signal that WS is ready so executors can proceed with order placement
      publishWsReady(redis, "okx", userId).catch((err) =>
        console.error(`OKX WS Worker: failed to publish ws-ready for user ${userId}:`, err),
      );

      // Run snapshot reconciliation after subscribing
      reconcileSnapshot(userId, creds).catch((err) =>
        console.error(`OKX WS Worker: reconciliation failed for user ${userId}:`, err),
      );
    } else {
      console.error(`OKX WS Worker: LOGIN FAILED for user ${userId}: code=${msg.code} msg=${msg.msg}`);
    }
    return;
  }

  // Handle subscription confirmation
  if (msg.event === "subscribe") {
    console.log(`OKX WS Worker: subscription confirmed for user ${userId}:`, msg.arg);
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
  console.warn(
    `OKX WS Worker: WS CLOSED user=${userId} code=${code} reason=${reason.toString()}`,
  );

  const state = connections.get(userId);
  if (!state) return;

  if (state.pingInterval) clearInterval(state.pingInterval);

  state.ws = null;
  state.loggedIn = false;
  connections.delete(userId);

  // Schedule reconnect with exponential backoff
  const delay = state.backoff;
  state.backoff = Math.min(state.backoff * 1.5, 60_000);

  console.log(`OKX WS Worker: Reconnecting user ${userId} in ${delay}ms...`);
  setTimeout(() => ensureConnection(userId), delay);
}

// ------------------------------------------- //
//          CLOSE USER CONNECTION
// ------------------------------------------- //

function closeConnection(userId: string) {
  console.log(`OKX WS Worker: Closing WS for user ${userId}`);

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
  console.log("OKX WS Worker: shutting down...");

  for (const [, st] of connections.entries()) {
    if (st.ws) st.ws.terminate();
  }
  process.exit(0);
});

// ------------------------------------------- //
//          MESSAGE HANDLERS
// ------------------------------------------- //

async function handleOrderUpdate(userId: string, order: any) {
  try {
    const ordId = order.ordId;
    const state = order.state; // live, partially_filled, filled, canceled

    console.log(`OKX WS Worker: ORDER UPDATE user=${userId} ordId=${ordId} state=${state} instId=${order.instId}`);

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
        console.log(`OKX WS Worker: Unknown order state: ${state}`);
    }

    if (!dbStatus) return;

    // Find trade by ordId
    const [trade] = await postgresDb
      .select()
      .from(trades)
      .where(eq(trades.trade_id, ordId))
      .limit(1);

    if (!trade) {
      console.warn(`OKX WS Worker: Trade not found for ordId ${ordId}, skipping`);
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

    console.log(`OKX WS Worker: Updated trade ${trade.id} to status: ${dbStatus}`);

    // Publish to Redis for UI
    await redis.publish(`user:${userId}:okx:orders:chan`, JSON.stringify(order));
  } catch (err) {
    console.error(`OKX WS Worker: Error handling order update for user ${userId}:`, err);
  }
}

async function handlePositionUpdate(userId: string, position: any) {
  try {
    const instId = position.instId;
    const pos = parseFloat(position.pos || "0");
    const upl = position.upl; // unrealized PnL
    const uplRatio = position.uplRatio;

    console.log(`OKX WS Worker: POSITION UPDATE user=${userId} instId=${instId} pos=${pos} upl=${upl}`);

    // If position is closed (pos === 0), find and close matching trades
    if (pos === 0) {
      const exchange = await postgresDb.query.exchanges.findFirst({
        columns: { id: true },
        where: eq(exchanges.exchange_user_id, userId),
      });

      if (!exchange) {
        console.warn(`OKX WS Worker: No exchange for user ${userId}`);
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

        console.log(`OKX WS Worker: Trade ${trade.id} (${instId}) closed via position update`);
      }
    }

    // Publish to Redis for UI
    await redis.publish(`user:${userId}:okx:positions:chan`, JSON.stringify(position));
  } catch (err) {
    console.error(`OKX WS Worker: Error handling position update for user ${userId}:`, err);
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
  console.log(`[OKX Reconcile] Starting snapshot reconciliation for user ${userId}`);

  const exchange = await postgresDb.query.exchanges.findFirst({
    columns: { id: true },
    where: eq(exchanges.exchange_user_id, userId),
  });
  if (!exchange) {
    console.warn(`[OKX Reconcile] No exchange record for exchange_user_id=${userId}`);
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

  console.log(`[OKX Reconcile] Found ${pendingTrades.length} pending trades to check`);

  for (const trade of pendingTrades) {
    try {
      const orderData = await okxRestGetOrder(creds, trade.contract, trade.trade_id);
      if (!orderData || orderData.status === "error") {
        console.warn(`[OKX Reconcile] Failed to fetch order ${trade.trade_id}:`, orderData);
        continue;
      }

      // OKX REST response: { code: "0", data: [{ state, avgPx, fillTime, ... }] }
      const order = orderData?.data?.[0];
      if (!order) continue;

      const state = order.state;
      console.log(`[OKX Reconcile] Order ${trade.trade_id} REST state: ${state}`);

      if (state === "filled") {
        await postgresDb
          .update(trades)
          .set({
            status: "waiting_targets",
            open_fill_price: order.avgPx || order.px,
            open_filled_at: order.fillTime ? Math.floor(Number(order.fillTime) / 1000) : undefined,
          })
          .where(eq(trades.id, trade.id));
        console.log(`[OKX Reconcile] Trade ${trade.id} updated to waiting_targets`);
      } else if (state === "canceled") {
        await postgresDb
          .update(trades)
          .set({ status: "cancelled", cancelled_at: new Date() })
          .where(eq(trades.id, trade.id));
        console.log(`[OKX Reconcile] Trade ${trade.id} updated to cancelled`);
      }
    } catch (err) {
      console.error(`[OKX Reconcile] Error checking order ${trade.trade_id}:`, err);
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
    console.log(`[OKX Reconcile] No waiting_targets trades to check`);
    return;
  }

  const positionsData = await okxRestGetPositions(creds);
  if (!positionsData || positionsData.status === "error") {
    console.warn(`[OKX Reconcile] Failed to fetch positions:`, positionsData);
    return;
  }

  // Build set of instIds that have an open position
  const openPositionInstIds = new Set<string>();
  for (const pos of positionsData?.data || []) {
    if (parseFloat(pos.pos || "0") !== 0) {
      openPositionInstIds.add(pos.instId);
    }
  }

  console.log(`[OKX Reconcile] Open position instruments: [${[...openPositionInstIds].join(", ")}]`);

  for (const trade of waitingTrades) {
    if (!openPositionInstIds.has(trade.contract)) {
      console.log(`[OKX Reconcile] Trade ${trade.id} (${trade.contract}) has no open position — marking closed`);
      await postgresDb
        .update(trades)
        .set({ status: "closed", closed_at: new Date() })
        .where(eq(trades.id, trade.id));
    }
  }

  console.log(`[OKX Reconcile] Snapshot reconciliation complete for user ${userId}`);
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

console.log("OKX Worker Runner started successfully");
