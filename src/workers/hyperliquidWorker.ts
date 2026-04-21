import WebSocket from "ws";
import Redis from "ioredis";
import { postgresDb } from "../db/client";
import { exchanges, trades } from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { publishWsReady } from "../utils/wsReady";
import { createLogger, flushLogger } from "../utils/logger";
import { wsConnectionsActive, tradesClosedTotal, exchangeErrorsTotal } from "../utils/metrics";

const log = createLogger({ exchange: "hyperliquid", process: "worker" });

const HL_BASE_URL = "https://api.hyperliquid.xyz";

// ---- Redis Setup ---- //
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const control = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const STREAM_KEY = "ws-control:hyperliquid";
const GROUP_NAME = "hyperliquid-workers";
const CONSUMER_NAME = `hyperliquid-worker-${process.pid}`;

// Each user has exactly one WS connection
interface HyperliquidConnection {
  ws: WebSocket | null;
  pingInterval?: NodeJS.Timeout;
  backoff: number;
  intentionalClose?: boolean;
  userAddress: string; // Master wallet address
}

const connections = new Map<string, HyperliquidConnection>();

// ---- Redis Streams consumer for ws-control:hyperliquid ---- //
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

    if (cmd.op === "open" && cmd.userId && cmd.userAddress) {
      ensureConnection(cmd.userId, cmd.userAddress);
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
          eq(exchanges.exchange_title, "hyperliquid"),
          inArray(trades.status, ["waiting_position", "partially_filled", "waiting_targets"]),
        ),
      );

    log.info({ count: activeTrades.length }, 'Found users with active trades to reconnect');

    for (const { exchange_user_id } of activeTrades) {
      ensureConnection(exchange_user_id, exchange_user_id);
    }
  } catch (err) {
    log.error({ err }, 'Failed to restore connections on startup');
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
    log.debug({ userId }, 'Connection already open');
    publishWsReady(redis, "hyperliquid", userId).catch(() => {});
    return;
  }

  if (!userAddress) {
    log.warn({ userId }, 'No wallet address for user');
    return;
  }

  log.info({ userId }, 'Opening WebSocket connection');

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
    log.error({ err, userId }, 'WebSocket error'),
  );
}

// ------------------------------------------- //
//             EVENT HANDLERS
// ------------------------------------------- //

function onWsOpen(userId: string, ws: WebSocket, userAddress: string) {
  log.info({ userId }, 'WebSocket open');

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
  log.info({ userId }, 'Subscribed to channels');

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
  log.info({ userId }, 'Subscribed to channels');

  // Signal that WS is ready so executors can proceed with order placement
  publishWsReady(redis, "hyperliquid", userId).catch((err: any) =>
    log.error({ err, userId }, 'Failed to publish ws-ready'),
  );

  // Run snapshot reconciliation after subscribing
  reconcileSnapshot(userId, userAddress).catch((err: any) =>
    log.error({ err, userId }, 'Reconciliation failed'),
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
      log.debug({ userId }, 'Ping sent');
    }
  }, 30_000); // Every 30 seconds
}

async function onWsMessage(userId: string, raw: Buffer) {
  let msg: any;
  try {
    msg = JSON.parse(raw.toString());
  } catch (err) {
    log.error({ err }, 'Failed to parse WS message');
    return;
  }

  const channel = msg?.channel;

  // Handle subscription response
  if (channel === "subscriptionResponse") {
    log.debug({ userId }, 'Subscription ACK');
    return;
  }

  // Handle pong
  if (channel === "pong") {
    log.debug({ userId }, 'Pong received');
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
  log.warn({ userId, code, reason: reason.toString() }, 'WebSocket closed');

  const state = connections.get(userId);
  if (!state) return;

  if (state.pingInterval) clearInterval(state.pingInterval);

  const isIntentionalClose = !!state.intentionalClose;

  // Mark connection as dead
  state.ws = null;
  connections.delete(userId);

  if (isIntentionalClose) {
    log.info({ userId }, 'WebSocket closed intentionally; skipping reconnect');
    return;
  }

  // Schedule reconnection with exponential backoff
  const delay = state.backoff;
  state.backoff = Math.min(state.backoff * 1.5, 60_000); // Max 60s

  log.info({ userId, delay }, 'Scheduling reconnect');

  setTimeout(() => ensureConnection(userId, state.userAddress), delay);
}

// ------------------------------------------- //
//          CLOSE USER CONNECTION
// ------------------------------------------- //

function closeConnection(userId: string) {
  log.info({ userId }, 'Closing WebSocket connection');

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

process.on("SIGINT", () => {
  log.info('Shutting down');

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
  log.info({ userId }, 'Starting snapshot reconciliation');

  const exchange = await postgresDb.query.exchanges.findFirst({
    columns: { id: true },
    where: eq(exchanges.exchange_user_id, userAddress.toLowerCase()),
  });
  if (!exchange) {
    log.warn({ userId }, 'No exchange record found for reconcile');
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

  log.info({ userId, count: pendingTrades.length }, 'Pending trades to reconcile');

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
          log.info('Reconcile: HL Reconcile] Order ${oid} still open, skipping');
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
            log.info('Reconcile: HL Reconcile] Trade ${trade.id} (oid=${oid}) filled+closed, PnL=${closedPnl}');
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
            log.info('Reconcile: HL Reconcile] Trade ${trade.id} (oid=${oid}) filled → waiting_targets');
          }
        } else {
          // No fill found and not in open orders → likely canceled
          await postgresDb
            .update(trades)
            .set({ status: "cancelled", cancelled_at: new Date() })
            .where(eq(trades.id, trade.id));
          log.info('Reconcile: HL Reconcile] Trade ${trade.id} (oid=${oid}) not found in open/fills → cancelled');
        }
      } catch (err) {
        log.error({ err, tradeId: trade.trade_id }, 'Reconcile: error checking trade');
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
    log.debug({ userId }, 'No waiting_targets trades to check');
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

  log.debug({ userId }, 'Open positions fetched');

  for (const trade of waitingTrades) {
    // Hyperliquid uses coin name (e.g. "BTC") not pair format
    // The trade.contract might be "BTC", "BTC-USDT", or "BTC_USDT"
    const tradeCoin = trade.contract.replace("-USDT", "").replace("_USDT", "");

    if (!openPositionCoins.has(tradeCoin)) {
      log.info({ tradeId: trade.id }, 'Trade has no open position — marking closed');

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

  log.info({ userId }, 'Snapshot reconciliation complete');
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
      log.error({ status: response.status }, 'HL Info request failed');
      return null;
    }
    return await response.json();
  } catch (err) {
    log.error({ err }, 'HL Info request error');
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

    log.debug({ userId, oid, status, coin: wsOrder.order.coin }, 'Order update');

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
        log.debug({ status }, 'Unknown order status');
    }

    if (!dbStatus) return;

    // Find trade by OID
    const [trade] = await postgresDb
      .select()
      .from(trades)
      .where(eq(trades.trade_id, oid))
      .limit(1);

    if (!trade) {
      log.warn({ oid }, 'Trade not found, skipping');
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

    log.info({ tradeId: trade.id, status: dbStatus }, 'Trade updated');

    // Publish to Redis
    await redis.publish(
      `user:${userId}:hyperliquid:orders:chan`,
      JSON.stringify(wsOrder),
    );
  } catch (err) {
    log.error({ err, userId }, 'Error handling order update');
  }
}

async function handleUserFill(userId: string, fillData: WsUserFills) {
  try {
    // Skip snapshot (historical data, likely already processed)
    if (fillData.isSnapshot === true) {
      log.debug({ userId }, 'Skipping snapshot');
      return;
    }

    log.debug({ userId, fillCount: fillData.fills.length }, 'Fills update');

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
    log.error({ err, userId }, 'Error handling user fills');
  }
}

async function processFill(userId: string, fill: WsFill) {
  try {
    const oid = String(fill.oid);
    const closedPnl = parseFloat(fill.closedPnl);
    const isPositionClosed = closedPnl !== 0;

    log.debug({ oid, coin: fill.coin, px: fill.px, sz: fill.sz, closedPnl: fill.closedPnl }, 'Processing fill');

    // Find trade by OID
    const [trade] = await postgresDb
      .select()
      .from(trades)
      .where(eq(trades.trade_id, oid))
      .limit(1);

    if (!trade) {
      log.warn({ oid, coin: fill.coin }, 'Fill received for unknown OID — may be manual or pre-worker order');
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
        log.info({ tradeId: trade.id }, 'First fill for trade');
      }

      // If position closed
      if (isPositionClosed) {
        updateData.status = "closed";
        updateData.pnl = closedPnl;
        updateData.closed_at = new Date();
        updateData.close_fill_price = fill.px;
        updateData.close_filled_at = Math.floor(fill.time / 1000);
        log.info({ tradeId: trade.id, pnl: closedPnl, price: fill.px }, 'Position closed');
        tradesClosedTotal.inc({ exchange: "hyperliquid" });
      }

      await tx
        .update(trades)
        .set(updateData)
        .where(eq(trades.id, trade.id));
    });

    log.info({ tradeId: trade.id }, 'Fill processed');
  } catch (err) {
    log.error({ err, oid: fill.oid }, 'Error processing fill');
    exchangeErrorsTotal.inc({ exchange: "hyperliquid", component: "worker" });
  }
}

log.info('Worker started successfully');
