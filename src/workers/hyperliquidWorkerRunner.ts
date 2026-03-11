import WebSocket from "ws";
import Redis from "ioredis";
import { postgresDb } from "../db/client";
import { exchanges, trades } from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { publishWsReady } from "../utils/wsReady";

const HL_BASE_URL = "https://api.hyperliquid.xyz";

// ---- Redis Setup ---- //
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const control = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const CTRL_CHANNEL = "ws-control";

// Each user has exactly one WS connection
interface HyperliquidConnection {
  ws: WebSocket | null;
  pingInterval?: NodeJS.Timeout;
  backoff: number;
  userAddress: string; // Master wallet address
}

const connections = new Map<string, HyperliquidConnection>();

// ---- Subscribe to control channel ---- //
(async () => {
  console.log("Hyperliquid WS Worker: Listening for control commands...");
  await control.subscribe(CTRL_CHANNEL);

  control.on("message", (chan, msg) => {
    if (chan !== CTRL_CHANNEL) return;

    try {
      const cmd = JSON.parse(msg);

      if (cmd.op === "open" && cmd.userId && cmd.userAddress) {
        ensureConnection(cmd.userId, cmd.userAddress);
      }

      if (cmd.op === "close" && cmd.userId) {
        closeConnection(cmd.userId);
      }
    } catch (err) {
      console.error("Hyperliquid WS Worker: invalid control command:", msg, err);
    }
  });
})();

// ---- Restore connections for users with active trades on startup ---- //
async function restoreConnections() {
  console.log("[HL WS] Restoring connections for users with active trades...");

  try {
    const activeTrades = await postgresDb
      .selectDistinct({ exchange_user_id: exchanges.exchange_user_id })
      .from(trades)
      .innerJoin(exchanges, eq(trades.exchange_id, exchanges.id))
      .where(
        and(
          eq(exchanges.exchange_title, "hyperliquid"),
          inArray(trades.status, ["waiting_position", "partially_filled", "waiting_targets"]),
        ),
      );

    console.log(`[HL WS] Found ${activeTrades.length} users with active trades to reconnect`);

    for (const { exchange_user_id } of activeTrades) {
      ensureConnection(exchange_user_id, exchange_user_id);
    }
  } catch (err) {
    console.error("[HL WS] Failed to restore connections on startup:", err);
  }
}

restoreConnections();

// Hyperliquid WS is unauthenticated — no API keys needed.
// The wallet address (exchange_user_id) is passed directly via ws-control command.

// ------------------------------------------- //
//       MAIN CONNECTION MANAGEMENT
// ------------------------------------------- //

async function ensureConnection(userId: string, userAddress: string) {
  let existing = connections.get(userId);

  if (existing?.ws && existing.ws.readyState === WebSocket.OPEN) {
    console.log(`Hyperliquid WS Worker: connection already open for user ${userId}`);
    publishWsReady(redis, "hyperliquid", userId).catch(() => {});
    return;
  }

  if (!userAddress) {
    console.warn(`Hyperliquid WS Worker: No wallet address for user ${userId}`);
    return;
  }

  console.log(`Hyperliquid WS Worker: Opening WS for user ${userId} (address: ${userAddress})`);

  // Determine WebSocket URL (check if testnet from exchanges table)
  const exchange = await postgresDb.query.exchanges.findFirst({
    where: eq(exchanges.exchange_user_id, userAddress),
  });

  const wsUrl = exchange?.testnet
    ? "wss://api.hyperliquid-testnet.xyz/ws"
    : "wss://api.hyperliquid.xyz/ws";

  const ws = new WebSocket(wsUrl);

  const state: HyperliquidConnection = {
    ws,
    backoff: existing ? existing.backoff : 1000,
    userAddress: userAddress.toLowerCase(),
  };
  connections.set(userId, state);

  ws.on("open", () => onWsOpen(userId, ws, userAddress));
  ws.on("message", (raw: Buffer) => onWsMessage(userId, raw));
  ws.on("close", (code, reason) => onWsClose(userId, code, reason));
  ws.on("error", (err) =>
    console.error(`Hyperliquid WS Worker: WS error (${userId})`, err),
  );
}

// ------------------------------------------- //
//             EVENT HANDLERS
// ------------------------------------------- //

function onWsOpen(userId: string, ws: WebSocket, userAddress: string) {
  console.log(`Hyperliquid WS Worker: WS OPEN for user ${userId}`);

  const state = connections.get(userId);
  if (!state) return;

  // Reset backoff after successful connection
  state.backoff = 1000;

  // Subscribe to orderUpdates
  ws.send(
    JSON.stringify({
      method: "subscribe",
      subscription: {
        type: "orderUpdates",
        user: userAddress,
      },
    }),
  );
  console.log(`📡 SUBSCRIBED (orderUpdates) user=${userId} address=${userAddress}`);

  // Subscribe to userFills
  ws.send(
    JSON.stringify({
      method: "subscribe",
      subscription: {
        type: "userFills",
        user: userAddress,
      },
    }),
  );
  console.log(`📡 SUBSCRIBED (userFills) user=${userId} address=${userAddress}`);

  // Signal that WS is ready so executors can proceed with order placement
  publishWsReady(redis, "hyperliquid", userId).catch((err: any) =>
    console.error(`Hyperliquid WS Worker: failed to publish ws-ready for user ${userId}:`, err),
  );

  // Run snapshot reconciliation after subscribing
  reconcileSnapshot(userId, userAddress).catch((err: any) =>
    console.error(`Hyperliquid WS Worker: reconciliation failed for user ${userId}:`, err),
  );

  // Setup ping interval (30 seconds - server timeout is 60s)
  if (state.pingInterval) clearInterval(state.pingInterval);

  state.pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          method: "ping",
        }),
      );
      console.log(`🏓 PING → user=${userId}`);
    }
  }, 30_000); // Every 30 seconds
}

async function onWsMessage(userId: string, raw: Buffer) {
  let msg: any;
  try {
    msg = JSON.parse(raw.toString());
  } catch (err) {
    console.error("Hyperliquid WS Worker: failed to parse WS message", err);
    return;
  }

  const channel = msg?.channel;

  // Handle subscription response
  if (channel === "subscriptionResponse") {
    console.log(
      `✅ Subscription ACK for user ${userId}:`,
      JSON.stringify(msg.data, null, 2),
    );
    return;
  }

  // Handle pong
  if (channel === "pong") {
    console.log(`🏓 PONG ← user=${userId}`);
    return;
  }

  // Handle order updates
  if (channel === "orderUpdates") {
    const orders = msg?.data;
    if (!orders || !Array.isArray(orders)) return;

    await Promise.all(
      orders.map(async (order: any) => {
        await handleOrderUpdate(userId, order);
      }),
    );
  }

  // Handle user fills
  if (channel === "userFills") {
    const fillData = msg?.data;
    if (!fillData) return;

    await handleUserFill(userId, fillData);
  }
}

function onWsClose(userId: string, code: number, reason: Buffer) {
  console.warn(
    `Hyperliquid WS Worker: WS CLOSED user=${userId} code=${code} reason=${reason.toString()}`,
  );

  const state = connections.get(userId);
  if (!state) return;

  if (state.pingInterval) clearInterval(state.pingInterval);

  // Mark connection as dead
  state.ws = null;
  connections.delete(userId);

  // Schedule reconnection with exponential backoff
  const delay = state.backoff;
  state.backoff = Math.min(state.backoff * 1.5, 60_000); // Max 60s

  console.log(`Hyperliquid WS Worker: Reconnecting user ${userId} in ${delay}ms...`);

  setTimeout(() => ensureConnection(userId, state.userAddress), delay);
}

// ------------------------------------------- //
//          CLOSE USER CONNECTION
// ------------------------------------------- //

function closeConnection(userId: string) {
  console.log(`Hyperliquid WS Worker: Closing WS for user ${userId}`);

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
  console.log("Hyperliquid WS Worker: shutting down...");

  for (const [userId, st] of connections.entries()) {
    if (st.ws) st.ws.terminate();
  }
  process.exit(0);
});

// ------------------------------------------- //
//        SNAPSHOT RECONCILIATION
// ------------------------------------------- //

/**
 * After WS subscribes, poll Hyperliquid REST info API to catch any
 * order/position changes that happened before WS was connected.
 *
 * Hyperliquid info endpoints are unauthenticated — just need the user address.
 */
async function reconcileSnapshot(userId: string, userAddress: string) {
  console.log(`[HL Reconcile] Starting snapshot reconciliation for user ${userId} (${userAddress})`);

  const exchange = await postgresDb.query.exchanges.findFirst({
    columns: { id: true },
    where: eq(exchanges.exchange_user_id, userAddress.toLowerCase()),
  });
  if (!exchange) {
    console.warn(`[HL Reconcile] No exchange record for address=${userAddress}`);
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

  console.log(`[HL Reconcile] Found ${pendingTrades.length} pending trades to check`);

  if (pendingTrades.length > 0) {
    // Fetch all open orders for this user
    const openOrders = await hlInfoRequest({ type: "openOrders", user: userAddress });
    const openOids = new Set<string>(
      Array.isArray(openOrders) ? openOrders.map((o: any) => String(o.oid)) : [],
    );

    // Fetch recent fills for context on filled orders
    const userFills = await hlInfoRequest({ type: "userFills", user: userAddress });
    const fillsByOid = new Map<string, any>();
    if (Array.isArray(userFills)) {
      for (const fill of userFills) {
        // Keep the most recent fill per OID
        fillsByOid.set(String(fill.oid), fill);
      }
    }

    for (const trade of pendingTrades) {
      try {
        const oid = trade.trade_id;

        if (openOids.has(oid)) {
          // Order is still open — no action needed
          console.log(`[HL Reconcile] Order ${oid} still open, skipping`);
          continue;
        }

        // Order is NOT in open orders — it's either filled, canceled, or rejected
        // Check if we have a fill for it
        const fill = fillsByOid.get(oid);

        if (fill) {
          const closedPnl = parseFloat(fill.closedPnl || "0");
          const isPositionClosed = closedPnl !== 0;

          if (isPositionClosed) {
            // Order filled AND position already closed
            await postgresDb.transaction(async (tx) => {
              await tx
                .update(trades)
                .set({
                  status: "closed",
                  open_fill_price: fill.px,
                  open_filled_at: Math.floor(fill.time / 1000),
                  close_fill_price: fill.px,
                  close_filled_at: Math.floor(fill.time / 1000),
                  pnl: closedPnl.toString(),
                  closed_at: new Date(),
                })
                .where(eq(trades.id, trade.id));
            });
            console.log(`[HL Reconcile] Trade ${trade.id} (oid=${oid}) filled+closed, PnL=${closedPnl}`);
          } else {
            // Order filled, position still open
            await postgresDb
              .update(trades)
              .set({
                status: "waiting_targets",
                open_fill_price: fill.px,
                open_filled_at: Math.floor(fill.time / 1000),
              })
              .where(eq(trades.id, trade.id));
            console.log(`[HL Reconcile] Trade ${trade.id} (oid=${oid}) filled → waiting_targets`);
          }
        } else {
          // No fill found and not in open orders → likely canceled
          await postgresDb
            .update(trades)
            .set({ status: "cancelled", cancelled_at: new Date() })
            .where(eq(trades.id, trade.id));
          console.log(`[HL Reconcile] Trade ${trade.id} (oid=${oid}) not found in open/fills → cancelled`);
        }
      } catch (err) {
        console.error(`[HL Reconcile] Error checking trade ${trade.trade_id}:`, err);
      }
    }
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
    console.log(`[HL Reconcile] No waiting_targets trades to check`);
    return;
  }

  // Fetch clearinghouse state for positions
  const clearinghouseState = await hlInfoRequest({
    type: "clearinghouseState",
    user: userAddress,
  });

  // Build set of coins with open positions
  const openPositionCoins = new Set<string>();
  const assetPositions = clearinghouseState?.assetPositions || [];
  for (const ap of assetPositions) {
    const pos = ap.position || ap;
    const szi = parseFloat(pos.szi || "0");
    if (szi !== 0) {
      openPositionCoins.add(pos.coin);
    }
  }

  console.log(`[HL Reconcile] Open position coins: [${[...openPositionCoins].join(", ")}]`);

  for (const trade of waitingTrades) {
    // Hyperliquid uses coin name (e.g. "BTC") not pair format
    // The trade.contract might be "BTC", "BTC-USDT", or "BTC_USDT"
    const tradeCoin = trade.contract.replace("-USDT", "").replace("_USDT", "");

    if (!openPositionCoins.has(tradeCoin)) {
      console.log(`[HL Reconcile] Trade ${trade.id} (${trade.contract}) has no open position — marking closed`);

      // Check fills for PnL data
      const userFills = await hlInfoRequest({ type: "userFills", user: userAddress });
      const tradeFill = Array.isArray(userFills)
        ? userFills.find((f: any) => String(f.oid) === trade.trade_id && parseFloat(f.closedPnl || "0") !== 0)
        : null;

      await postgresDb
        .update(trades)
        .set({
          status: "closed",
          closed_at: new Date(),
          pnl: tradeFill ? tradeFill.closedPnl : "0",
          close_fill_price: tradeFill?.px,
          close_filled_at: tradeFill ? Math.floor(tradeFill.time / 1000) : undefined,
        })
        .where(eq(trades.id, trade.id));
    }
  }

  console.log(`[HL Reconcile] Snapshot reconciliation complete for user ${userId}`);
}

/**
 * Helper to call Hyperliquid's unauthenticated info API.
 */
async function hlInfoRequest(body: Record<string, any>) {
  try {
    const response = await fetch(`${HL_BASE_URL}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error(`[HL Info] Request failed: ${response.status} ${await response.text()}`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.error(`[HL Info] Request error:`, err);
    return null;
  }
}

// ------------------------------------------- //
//          MESSAGE HANDLERS
// ------------------------------------------- //

// Type definitions based on Hyperliquid docs
interface WsOrder {
  order: {
    coin: string;
    side: string; // "A" (ask/sell) or "B" (bid/buy)
    limitPx: string;
    sz: string;
    oid: number;
    timestamp: number;
    origSz: string;
    cloid?: string;
  };
  status: string; // "open", "filled", "canceled", "rejected", etc.
  statusTimestamp: number;
}

interface WsUserFills {
  isSnapshot?: boolean;
  user: string;
  fills: WsFill[];
}

interface WsFill {
  coin: string; // e.g., "BTC" (without quote currency)
  px: string; // execution price
  sz: string; // fill size
  side: string; // "A" (ask/sell) or "B" (bid/buy)
  time: number; // timestamp in milliseconds
  oid: number; // order ID
  closedPnl: string; // CRITICAL: non-zero means position closed
  startPosition: string; // position size before fill
  fee: string;
  crossed: boolean; // true = taker, false = maker
  hash: string; // L1 transaction hash
  tid: number; // unique trade ID
  dir: string; // frontend display
  feeToken: string;
  builderFee?: string;
}

async function handleOrderUpdate(userId: string, wsOrder: WsOrder) {
  try {
    const oid = String(wsOrder.order.oid);
    const status = wsOrder.status;

    console.log(
      `📥 ORDER UPDATE user=${userId} oid=${oid} status=${status} coin=${wsOrder.order.coin}`,
    );

    // Map Hyperliquid status to database status
    let dbStatus: string | null = null;
    switch (status) {
      case "open":
        dbStatus = "waiting_position";
        break;
      case "filled":
        dbStatus = "waiting_targets";
        break;
      case "partiallyFilled":
        dbStatus = "partially_filled";
        break;
      case "canceled":
        dbStatus = "cancelled";
        break;
      case "rejected":
        dbStatus = "error";
        break;
      default:
        console.log(`Unknown order status: ${status}`);
    }

    if (!dbStatus) return;

    // Find trade by OID
    const [trade] = await postgresDb
      .select()
      .from(trades)
      .where(eq(trades.trade_id, oid))
      .limit(1);

    if (!trade) {
      console.warn(`Trade not found for OID ${oid}, skipping order update`);
      return;
    }

    // Update trade status and metadata
    await postgresDb
      .update(trades)
      .set({
        status: dbStatus,
        metadata: {
          ...((trade.metadata as any) || {}),
          lastOrderUpdate: wsOrder,
        },
      })
      .where(eq(trades.id, trade.id));

    console.log(`✅ Updated trade ${trade.id} to status: ${dbStatus}`);

    // Publish to Redis
    await redis.publish(
      `user:${userId}:hyperliquid:orders:chan`,
      JSON.stringify(wsOrder),
    );
  } catch (err) {
    console.error(`Error handling order update for user ${userId}:`, err);
  }
}

async function handleUserFill(userId: string, fillData: WsUserFills) {
  try {
    // Skip snapshot (historical data, likely already processed)
    if (fillData.isSnapshot === true) {
      console.log(`📸 Skipping snapshot for user ${userId} (${fillData.fills.length} fills)`);
      return;
    }

    console.log(
      `💰 FILLS UPDATE user=${userId} count=${fillData.fills.length}`,
    );

    console.log(JSON.stringify(fillData, null, 2), "fillData")

    // Process each fill
    await Promise.all(
      fillData.fills.map(async (fill: WsFill) => {
        await processFill(userId, fill);
      }),
    );

    // Publish to Redis
    await redis.publish(
      `user:${userId}:hyperliquid:fills:chan`,
      JSON.stringify(fillData),
    );
  } catch (err) {
    console.error(`Error handling user fills for user ${userId}:`, err);
  }
}

async function processFill(userId: string, fill: WsFill) {
  try {
    const oid = String(fill.oid);
    const closedPnl = parseFloat(fill.closedPnl);
    const isPositionClosed = closedPnl !== 0;

    console.log(
      `🔍 Processing fill: oid=${oid} coin=${fill.coin} px=${fill.px} sz=${fill.sz} closedPnl=${fill.closedPnl}`,
    );

    // Find trade by OID
    const [trade] = await postgresDb
      .select()
      .from(trades)
      .where(eq(trades.trade_id, oid))
      .limit(1);

    if (!trade) {
      console.warn(
        `Fill received for unknown OID ${oid} (coin: ${fill.coin}). May be manual order or pre-worker order.`,
      );
      return;
    }

    // Use transaction for atomic updates
    await postgresDb.transaction(async (tx) => {
      const updateData: any = {
        metadata: {
          ...((trade.metadata as any) || {}),
          lastFill: fill,
          totalFees: (((trade.metadata as any)?.totalFees || 0) + parseFloat(fill.fee)),
        },
      };

      // If first fill (status was waiting_position)
      if (trade.status === "waiting_position") {
        updateData.status = "waiting_targets";
        updateData.open_fill_price = fill.px;
        updateData.open_filled_at = Math.floor(fill.time / 1000); // Convert ms to seconds
        console.log(`🎯 First fill for trade ${trade.id}: setting fill price and time`);
      }

      // If position closed
      if (isPositionClosed) {
        updateData.status = "closed";
        updateData.pnl = closedPnl;
        updateData.closed_at = new Date();
        updateData.close_fill_price = fill.px;
        updateData.close_filled_at = Math.floor(fill.time / 1000);
        console.log(
          `🔒 Position closed for trade ${trade.id}: PnL=${closedPnl} price=${fill.px}`,
        );
      }

      await tx
        .update(trades)
        .set(updateData)
        .where(eq(trades.id, trade.id));
    });

    console.log(`✅ Processed fill for trade ${trade.id}`);
  } catch (err) {
    console.error(`Error processing fill for oid ${fill.oid}:`, err);
  }
}

console.log("🚀 Hyperliquid Worker Runner started successfully");
