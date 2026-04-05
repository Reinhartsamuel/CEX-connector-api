/**
 * ReconcileCron — periodic REST cross-check for all 4 exchanges.
 *
 * Runs every 60s (configurable via RECONCILE_INTERVAL_MS).
 * For each exchange, finds all active trades per user and verifies them
 * against the exchange REST API, correcting any stale DB state.
 *
 * This catches trade state changes (fills, closes) that were missed while
 * a worker was down or a WS connection was briefly dropped — gaps that
 * reconcileSnapshot() (run only on WS connect) cannot cover.
 */

import crypto from "crypto";
import { postgresDb } from "../db/client";
import { exchanges, trades } from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { decryptExchangeCreds } from "../utils/cryptography/decryptExchangeCreds";
import { signRequestRestGate } from "../utils/authentication/signRequestGate";
import { signRequestOkx } from "../utils/authentication/signRequestOkx";
import JSONbig from "json-bigint";

const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS) || 60_000;
const GATE_BASE_URL = "https://api.gateio.ws";
const OKX_BASE_URL = "https://www.okx.com";
const HL_BASE_URL = "https://api.hyperliquid.xyz";
const TOKO_BASE_URL = "https://api.tokocrypto.com";
const BITGET_BASE_URL = "https://api.bitget.com";
const MEXC_BASE_URL = "https://api.mexc.com";
const BITMART_BASE_URL = "https://api-cloud.bitmart.com";

// Per-exchange mutex — prevents overlapping runs if one tick takes longer than the interval
const running = new Map<string, boolean>();

// ---- Main loop ---- //

async function runReconcile(exchange: string) {
  if (running.get(exchange)) {
    console.log(`[ReconcileCron:${exchange}] Already running, skipping`);
    return;
  }
  running.set(exchange, true);
  const start = Date.now();

  try {
    const corrections = await reconcileExchange(exchange);
    console.log(
      `[ReconcileCron:${exchange}] Done in ${Date.now() - start}ms — ${corrections} correction(s)`,
    );
  } catch (err) {
    console.error(`[ReconcileCron:${exchange}] Failed:`, err);
  } finally {
    running.delete(exchange);
  }
}

async function reconcileExchange(exchangeTitle: string): Promise<number> {
  // Find all distinct users who have active trades on this exchange
  const activeRows = await postgresDb
    .selectDistinct({
      exchange_id: exchanges.id,
      exchange_user_id: exchanges.exchange_user_id,
    })
    .from(trades)
    .innerJoin(exchanges, eq(trades.exchange_id, exchanges.id))
    .where(
      and(
        eq(exchanges.exchange_title, exchangeTitle),
        inArray(trades.status, ["waiting_position", "partially_filled", "waiting_targets"]),
      ),
    );

  if (activeRows.length === 0) return 0;

  let total = 0;
  for (const row of activeRows) {
    try {
      const n = await reconcileUser(exchangeTitle, row.exchange_id, row.exchange_user_id);
      total += n;
    } catch (err) {
      console.error(
        `[ReconcileCron:${exchangeTitle}] Error reconciling user ${row.exchange_user_id}:`,
        err,
      );
    }
  }
  return total;
}

async function reconcileUser(
  exchangeTitle: string,
  exchangeId: number,
  userId: string,
): Promise<number> {
  switch (exchangeTitle) {
    case "gate":        return reconcileGate(exchangeId, userId);
    case "okx":         return reconcileOkx(exchangeId, userId);
    case "hyperliquid": return reconcileHyperliquid(exchangeId, userId);
    case "tokocrypto":  return reconcileTokocrypto(exchangeId, userId);
    case "bitget":      return reconcileBitget(exchangeId, userId);
    case "mexc":        return reconcileMexc(exchangeId, userId);
    case "bitmart":     return reconcileBitmart(exchangeId, userId);
    default:            return 0;
  }
}

// ============================================================
// GATE
// ============================================================

async function reconcileGate(exchangeId: number, userId: string): Promise<number> {
  const rawCreds = await decryptExchangeCreds(userId);
  if (!rawCreds) {
    console.warn(`[ReconcileCron:gate] No creds for user ${userId}`);
    return 0;
  }
  const creds = { apiKey: rawCreds.apiKey, apiSecret: rawCreds.apiSecret };
  let corrections = 0;

  // ---- Phase 1: waiting_position / partially_filled → check order REST ----
  const pendingTrades = await postgresDb
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.exchange_id, exchangeId),
        inArray(trades.status, ["waiting_position", "partially_filled"]),
      ),
    );

  // Collect REST results first, then batch-apply in a single transaction
  const pendingUpdates: Array<{ id: number; set: Record<string, any> }> = [];

  for (const trade of pendingTrades) {
    try {
      const order = await gateGetOrder(creds, trade.trade_id);
      if (!order || order.status === "error") continue;

      const event = classifyGateOrder(order);

      if (event === "filled_open") {
        pendingUpdates.push({
          id: trade.id,
          set: {
            status: "waiting_targets",
            open_fill_price: order.fill_price ?? order.price,
            open_filled_at: order.finish_time ? Number(order.finish_time) : undefined,
          },
        });
      } else if (event === "filled_close") {
        pendingUpdates.push({
          id: trade.id,
          set: { status: "closed", closed_at: new Date() },
        });
      } else if (event === "cancelled") {
        pendingUpdates.push({
          id: trade.id,
          set: { status: "cancelled", cancelled_at: new Date() },
        });
      }
      // "partial_fill" and "other" → no action, worker will handle via WS
    } catch (err) {
      console.error(
        `[ReconcileCron:gate] Error checking order ${trade.trade_id} for user ${userId}:`,
        err,
      );
    }
  }

  if (pendingUpdates.length > 0) {
    await postgresDb.transaction(async (tx) => {
      for (const { id, set } of pendingUpdates) {
        // Status guard: only update if still in a pending state
        await tx
          .update(trades)
          .set(set)
          .where(
            and(eq(trades.id, id), inArray(trades.status, ["waiting_position", "partially_filled"])),
          );
        corrections++;
        console.log(`[ReconcileCron:gate] Corrected trade ${id} → ${set.status}`);
      }
    });
  }

  // ---- Phase 2: waiting_targets → closed? (check if position still exists) ----
  const waitingTrades = await postgresDb
    .select()
    .from(trades)
    .where(and(eq(trades.exchange_id, exchangeId), eq(trades.status, "waiting_targets")));

  if (waitingTrades.length === 0) return corrections;

  const positions = await gateGetPositions(creds);
  if (!positions || !Array.isArray(positions)) return corrections;

  const openContracts = new Set<string>(
    positions.filter((p: any) => Number(p.size ?? 0) !== 0).map((p: any) => p.contract),
  );

  const closedUpdates: Array<{ id: number; pnl: string }> = [];

  for (const trade of waitingTrades) {
    if (!openContracts.has(trade.contract)) {
      let pnl = "0";
      try {
        const order = await gateGetOrder(creds, trade.trade_id);
        pnl = order?.realised_pnl ?? "0";
      } catch {}
      closedUpdates.push({ id: trade.id, pnl });
    }
  }

  if (closedUpdates.length > 0) {
    await postgresDb.transaction(async (tx) => {
      for (const { id, pnl } of closedUpdates) {
        // Status guard: only close if still waiting_targets
        await tx
          .update(trades)
          .set({ status: "closed", closed_at: new Date(), pnl })
          .where(and(eq(trades.id, id), eq(trades.status, "waiting_targets")));
        corrections++;
        console.log(`[ReconcileCron:gate] Corrected trade ${id} → closed (pnl=${pnl})`);
      }
    });
  }

  return corrections;
}

// Mirrors classifyOrderEvent() in gateWorker.ts
function classifyGateOrder(
  order: any,
): "filled_open" | "filled_close" | "cancelled" | "partial_fill" | "other" {
  const finish = order?.finish_as ?? null;
  const left = Number(order?.left ?? 0);
  const status = order?.status ?? null;
  const isReduce = Boolean(order?.is_reduce_only || order?.is_close);
  const size = Number(order?.size ?? 0);

  if (status === "finished" && finish === "filled" && left === 0) {
    return isReduce ? "filled_close" : "filled_open";
  }
  if (finish === "cancelled") return "cancelled";
  if (left > 0 && left < Math.abs(size)) return "partial_fill";
  return "other";
}

async function gateGetOrder(
  creds: { apiKey: string; apiSecret: string },
  orderId: string,
) {
  const urlPath = `/api/v4/futures/usdt/orders/${orderId}`;
  const headers = signRequestRestGate(
    { key: creds.apiKey, secret: creds.apiSecret },
    { method: "GET", urlPath, queryString: "", payload: "" },
  );
  const res = await fetch(`${GATE_BASE_URL}${urlPath}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", ...headers },
  });
  if (!res.ok) return { status: "error" as const };
  return JSONbig.parse(await res.text());
}

async function gateGetPositions(creds: { apiKey: string; apiSecret: string }) {
  const urlPath = "/api/v4/futures/usdt/positions";
  const headers = signRequestRestGate(
    { key: creds.apiKey, secret: creds.apiSecret },
    { method: "GET", urlPath, queryString: "", payload: "" },
  );
  const res = await fetch(`${GATE_BASE_URL}${urlPath}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", ...headers },
  });
  if (!res.ok) return null;
  return JSONbig.parse(await res.text());
}

// ============================================================
// OKX
// ============================================================

async function reconcileOkx(exchangeId: number, userId: string): Promise<number> {
  const rawCreds = await decryptExchangeCreds(userId);
  if (!rawCreds || !rawCreds.passphrase) {
    console.warn(`[ReconcileCron:okx] No creds for user ${userId}`);
    return 0;
  }
  const creds = {
    apiKey: rawCreds.apiKey,
    apiSecret: rawCreds.apiSecret,
    passphrase: rawCreds.passphrase,
  };
  let corrections = 0;

  // ---- Phase 1: waiting_position / partially_filled → check order REST ----
  const pendingTrades = await postgresDb
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.exchange_id, exchangeId),
        inArray(trades.status, ["waiting_position", "partially_filled"]),
      ),
    );

  const pendingUpdates: Array<{ id: number; set: Record<string, any> }> = [];

  for (const trade of pendingTrades) {
    try {
      const res = await okxGetOrder(creds, trade.contract, trade.trade_id);
      const order = res?.data?.[0];
      if (!order) continue;

      const state = order.state;

      if (state === "filled") {
        pendingUpdates.push({
          id: trade.id,
          set: {
            status: "waiting_targets",
            open_fill_price: order.avgPx || order.px,
            open_filled_at: order.fillTime
              ? Math.floor(Number(order.fillTime) / 1000)
              : undefined,
          },
        });
      } else if (state === "canceled") {
        pendingUpdates.push({
          id: trade.id,
          set: { status: "cancelled", cancelled_at: new Date() },
        });
      }
    } catch (err) {
      console.error(
        `[ReconcileCron:okx] Error checking order ${trade.trade_id} for user ${userId}:`,
        err,
      );
    }
  }

  if (pendingUpdates.length > 0) {
    await postgresDb.transaction(async (tx) => {
      for (const { id, set } of pendingUpdates) {
        await tx
          .update(trades)
          .set(set)
          .where(
            and(eq(trades.id, id), inArray(trades.status, ["waiting_position", "partially_filled"])),
          );
        corrections++;
        console.log(`[ReconcileCron:okx] Corrected trade ${id} → ${set.status}`);
      }
    });
  }

  // ---- Phase 2: waiting_targets → closed? ----
  const waitingTrades = await postgresDb
    .select()
    .from(trades)
    .where(and(eq(trades.exchange_id, exchangeId), eq(trades.status, "waiting_targets")));

  if (waitingTrades.length === 0) return corrections;

  const posData = await okxGetPositions(creds);
  if (!posData?.data) return corrections;

  const openInstIds = new Set<string>(
    posData.data
      .filter((p: any) => parseFloat(p.pos || "0") !== 0)
      .map((p: any) => p.instId),
  );

  const closedUpdates: Array<{ id: number; pnl: string }> = [];

  for (const trade of waitingTrades) {
    if (!openInstIds.has(trade.contract)) {
      // Fetch realized PnL from order history — matches handlePositionUpdate in okxWorker.ts
      let pnl = "0";
      try {
        const res = await okxGetOrder(creds, trade.contract, trade.trade_id);
        const order = res?.data?.[0];
        pnl = order?.realizedPnl || order?.pnl || "0";
      } catch {}
      closedUpdates.push({ id: trade.id, pnl });
    }
  }

  if (closedUpdates.length > 0) {
    await postgresDb.transaction(async (tx) => {
      for (const { id, pnl } of closedUpdates) {
        await tx
          .update(trades)
          .set({ status: "closed", closed_at: new Date(), pnl })
          .where(and(eq(trades.id, id), eq(trades.status, "waiting_targets")));
        corrections++;
        console.log(`[ReconcileCron:okx] Corrected trade ${id} → closed (pnl=${pnl})`);
      }
    });
  }

  return corrections;
}

async function okxGetOrder(
  creds: { apiKey: string; apiSecret: string; passphrase: string },
  instId: string,
  ordId: string,
) {
  const requestPath = `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`;
  const headers = signRequestOkx(
    { key: creds.apiKey, secret: creds.apiSecret, passphrase: creds.passphrase },
    { method: "GET", requestPath },
  );
  const res = await fetch(`${OKX_BASE_URL}${requestPath}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", ...headers },
  });
  if (!res.ok) return null;
  return await res.json();
}

async function okxGetPositions(
  creds: { apiKey: string; apiSecret: string; passphrase: string },
) {
  const requestPath = "/api/v5/account/positions?instType=SWAP";
  const headers = signRequestOkx(
    { key: creds.apiKey, secret: creds.apiSecret, passphrase: creds.passphrase },
    { method: "GET", requestPath },
  );
  const res = await fetch(`${OKX_BASE_URL}${requestPath}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", ...headers },
  });
  if (!res.ok) return null;
  return await res.json();
}

// ============================================================
// HYPERLIQUID
// ============================================================

async function reconcileHyperliquid(exchangeId: number, userId: string): Promise<number> {
  // Hyperliquid info API is unauthenticated.
  // For Hyperliquid, exchange_user_id IS the wallet address — no KMS creds needed.
  const userAddress = userId.toLowerCase();
  let corrections = 0;

  // ---- Phase 1: waiting_position / partially_filled → check open orders + fills ----
  const pendingTrades = await postgresDb
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.exchange_id, exchangeId),
        inArray(trades.status, ["waiting_position", "partially_filled"]),
      ),
    );

  // Fetch both in parallel, cache for reuse in Phase 2
  let cachedFills: any[] | null = null;

  if (pendingTrades.length > 0) {
    const [openOrders, userFills] = await Promise.all([
      hlInfo({ type: "openOrders", user: userAddress }),
      hlInfo({ type: "userFills", user: userAddress }),
    ]);

    cachedFills = Array.isArray(userFills) ? userFills : [];

    const openOids = new Set<string>(
      Array.isArray(openOrders) ? openOrders.map((o: any) => String(o.oid)) : [],
    );
    const fillsByOid = new Map<string, any>();
    for (const f of cachedFills) fillsByOid.set(String(f.oid), f);

    const pendingUpdates: Array<{ id: number; set: Record<string, any> }> = [];

    for (const trade of pendingTrades) {
      try {
        if (openOids.has(trade.trade_id)) continue; // still open, no action

        const fill = fillsByOid.get(trade.trade_id);
        if (fill) {
          const closedPnl = parseFloat(fill.closedPnl || "0");
          if (closedPnl !== 0) {
            // Filled and position already closed in the same event
            pendingUpdates.push({
              id: trade.id,
              set: {
                status: "closed",
                open_fill_price: fill.px,
                open_filled_at: Math.floor(fill.time / 1000),
                close_fill_price: fill.px,
                close_filled_at: Math.floor(fill.time / 1000),
                pnl: closedPnl.toString(),
                closed_at: new Date(),
              },
            });
          } else {
            // Filled, position still open
            pendingUpdates.push({
              id: trade.id,
              set: {
                status: "waiting_targets",
                open_fill_price: fill.px,
                open_filled_at: Math.floor(fill.time / 1000),
              },
            });
          }
        } else {
          // Not in open orders and no fill → cancelled/rejected
          pendingUpdates.push({
            id: trade.id,
            set: { status: "cancelled", cancelled_at: new Date() },
          });
        }
      } catch (err) {
        console.error(
          `[ReconcileCron:hyperliquid] Error checking trade ${trade.trade_id} for user ${userId}:`,
          err,
        );
      }
    }

    if (pendingUpdates.length > 0) {
      await postgresDb.transaction(async (tx) => {
        for (const { id, set } of pendingUpdates) {
          await tx
            .update(trades)
            .set(set)
            .where(
              and(
                eq(trades.id, id),
                inArray(trades.status, ["waiting_position", "partially_filled"]),
              ),
            );
          corrections++;
          console.log(
            `[ReconcileCron:hyperliquid] Corrected trade ${id} → ${set.status}`,
          );
        }
      });
    }
  }

  // ---- Phase 2: waiting_targets → closed? ----
  const waitingTrades = await postgresDb
    .select()
    .from(trades)
    .where(and(eq(trades.exchange_id, exchangeId), eq(trades.status, "waiting_targets")));

  if (waitingTrades.length === 0) return corrections;

  const state = await hlInfo({ type: "clearinghouseState", user: userAddress });
  const openCoins = new Set<string>(
    (state?.assetPositions || [])
      .filter((ap: any) => parseFloat((ap.position || ap).szi || "0") !== 0)
      .map((ap: any) => (ap.position || ap).coin),
  );

  // Reuse fills from Phase 1 if available, otherwise fetch fresh
  if (!cachedFills) {
    const userFills = await hlInfo({ type: "userFills", user: userAddress });
    cachedFills = Array.isArray(userFills) ? userFills : [];
  }

  const closedUpdates: Array<{ id: number; set: Record<string, any> }> = [];

  for (const trade of waitingTrades) {
    // Hyperliquid contracts stored as "BTC", "BTC-USDT", or "BTC_USDT" — extract coin name
    const coin = trade.contract.replace(/-USDT$/i, "").replace(/_USDT$/i, "");

    if (!openCoins.has(coin)) {
      const closeFill = cachedFills.find(
        (f: any) =>
          String(f.oid) === trade.trade_id && parseFloat(f.closedPnl || "0") !== 0,
      );
      closedUpdates.push({
        id: trade.id,
        set: {
          status: "closed",
          closed_at: new Date(),
          pnl: closeFill ? closeFill.closedPnl : "0",
          close_fill_price: closeFill?.px ?? undefined,
          close_filled_at: closeFill ? Math.floor(closeFill.time / 1000) : undefined,
        },
      });
    }
  }

  if (closedUpdates.length > 0) {
    await postgresDb.transaction(async (tx) => {
      for (const { id, set } of closedUpdates) {
        await tx
          .update(trades)
          .set(set)
          .where(and(eq(trades.id, id), eq(trades.status, "waiting_targets")));
        corrections++;
        console.log(`[ReconcileCron:hyperliquid] Corrected trade ${id} → closed`);
      }
    });
  }

  return corrections;
}

async function hlInfo(body: Record<string, any>) {
  try {
    const res = await fetch(`${HL_BASE_URL}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ============================================================
// TOKOCRYPTO (Binance Cloud)
// ============================================================

async function reconcileTokocrypto(exchangeId: number, userId: string): Promise<number> {
  // Uses KMS-decrypted creds (same as all other exchanges).
  // Note: tokocryptoWorker.ts has a bug where it reads from Redis cache that is never
  // populated — the correct credential source is KMS via decryptExchangeCreds.
  const rawCreds = await decryptExchangeCreds(userId);
  if (!rawCreds) {
    console.warn(`[ReconcileCron:tokocrypto] No creds for user ${userId}`);
    return 0;
  }
  const { apiKey, apiSecret } = rawCreds;
  let corrections = 0;

  function sign(queryString: string): string {
    return crypto.createHmac("sha256", apiSecret).update(queryString).digest("hex");
  }

  // ---- Phase 1: waiting_position / partially_filled → check order REST ----
  const pendingTrades = await postgresDb
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.exchange_id, exchangeId),
        inArray(trades.status, ["waiting_position", "partially_filled"]),
      ),
    );

  const pendingUpdates: Array<{ id: number; set: Record<string, any> }> = [];

  for (const trade of pendingTrades) {
    try {
      // Tokocrypto (Binance Futures) symbol format: no separator, e.g. "BTCUSDT"
      const symbol = trade.contract.replace("/", "").replace("_", "").replace("-", "");
      const timestamp = Date.now();
      const qs = `symbol=${symbol}&orderId=${trade.trade_id}&timestamp=${timestamp}`;
      const res = await fetch(`${TOKO_BASE_URL}/fapi/v1/order?${qs}&signature=${sign(qs)}`, {
        method: "GET",
        headers: { "X-MBX-APIKEY": apiKey },
      });

      if (!res.ok) continue;
      const order = await res.json();
      const state: string = order.status;

      if (state === "FILLED") {
        pendingUpdates.push({
          id: trade.id,
          set: {
            status: "waiting_targets",
            open_fill_price: order.avgPrice || order.price,
            open_filled_at: order.updateTime
              ? Math.floor(Number(order.updateTime) / 1000)
              : undefined,
          },
        });
      } else if (state === "CANCELED" || state === "CANCELLED" || state === "EXPIRED") {
        pendingUpdates.push({
          id: trade.id,
          set: { status: "cancelled", cancelled_at: new Date() },
        });
      }
    } catch (err) {
      console.error(
        `[ReconcileCron:tokocrypto] Error checking order ${trade.trade_id} for user ${userId}:`,
        err,
      );
    }
  }

  if (pendingUpdates.length > 0) {
    await postgresDb.transaction(async (tx) => {
      for (const { id, set } of pendingUpdates) {
        await tx
          .update(trades)
          .set(set)
          .where(
            and(
              eq(trades.id, id),
              inArray(trades.status, ["waiting_position", "partially_filled"]),
            ),
          );
        corrections++;
        console.log(`[ReconcileCron:tokocrypto] Corrected trade ${id} → ${set.status}`);
      }
    });
  }

  // ---- Phase 2: waiting_targets → closed? ----
  const waitingTrades = await postgresDb
    .select()
    .from(trades)
    .where(and(eq(trades.exchange_id, exchangeId), eq(trades.status, "waiting_targets")));

  if (waitingTrades.length === 0) return corrections;

  const timestamp2 = Date.now();
  const qs2 = `timestamp=${timestamp2}`;

  let positions: any[] = [];
  try {
    const res = await fetch(`${TOKO_BASE_URL}/fapi/v2/positionRisk?${qs2}&signature=${sign(qs2)}`, {
      method: "GET",
      headers: { "X-MBX-APIKEY": apiKey },
    });
    if (!res.ok) return corrections;
    const data = await res.json();
    positions = Array.isArray(data) ? data : [];
  } catch (err) {
    console.error(`[ReconcileCron:tokocrypto] Error fetching positions for user ${userId}:`, err);
    return corrections;
  }

  const openSymbols = new Set<string>(
    positions
      .filter((p: any) => parseFloat(p.positionAmt || "0") !== 0)
      .map((p: any) => p.symbol),
  );

  const closedUpdates: Array<{ id: number }> = [];

  for (const trade of waitingTrades) {
    const symbol = trade.contract.replace("/", "").replace("_", "").replace("-", "");
    if (!openSymbols.has(symbol)) {
      closedUpdates.push({ id: trade.id });
    }
  }

  if (closedUpdates.length > 0) {
    await postgresDb.transaction(async (tx) => {
      for (const { id } of closedUpdates) {
        // Tokocrypto REST positionRisk doesn't return realized PnL directly;
        // setting pnl=null here — the ACCOUNT_UPDATE WS event carries rp (realized PnL).
        await tx
          .update(trades)
          .set({ status: "closed", closed_at: new Date() })
          .where(and(eq(trades.id, id), eq(trades.status, "waiting_targets")));
        corrections++;
        console.log(`[ReconcileCron:tokocrypto] Corrected trade ${id} → closed`);
      }
    });
  }

  return corrections;
}

// ============================================================
// BITGET (CCXT-based - similar pattern to Tokocrypto but uses CCXT)
// ============================================================

async function reconcileBitget(exchangeId: number, userId: string): Promise<number> {
  const rawCreds = await decryptExchangeCreds(userId);
  if (!rawCreds || !rawCreds.passphrase) {
    console.warn(`[ReconcileCron:bitget] No creds for user ${userId}`);
    return 0;
  }
  // For now, skip Bitget reconciliation - would need CCXT integration or custom REST signing
  // Same pattern as tokocrypto but with Bitget-specific API
  console.log(`[ReconcileCron:bitget] Skipped - TODO: implement REST signing`);
  return 0;
}

// ============================================================
// MEXC (CCXT-based - similar pattern to Tokocrypto)
// ============================================================

async function reconcileMexc(exchangeId: number, userId: string): Promise<number> {
  const rawCreds = await decryptExchangeCreds(userId);
  if (!rawCreds) {
    console.warn(`[ReconcileCron:mexc] No creds for user ${userId}`);
    return 0;
  }
  // For now, skip MEXC reconciliation - would need CCXT integration or custom REST signing
  console.log(`[ReconcileCron:mexc] Skipped - TODO: implement REST signing`);
  return 0;
}

// ============================================================
// BITMART (CCXT-based - similar pattern to Tokocrypto)
// ============================================================

async function reconcileBitmart(exchangeId: number, userId: string): Promise<number> {
  const rawCreds = await decryptExchangeCreds(userId);
  if (!rawCreds || !rawCreds.passphrase) {
    console.warn(`[ReconcileCron:bitmart] No creds for user ${userId}`);
    return 0;
  }
  // For now, skip BitMart reconciliation - would need CCXT integration or custom REST signing
  console.log(`[ReconcileCron:bitmart] Skipped - TODO: implement REST signing`);
  return 0;
}

// ============================================================
// Start
// ============================================================

const EXCHANGES = ["gate", "okx", "hyperliquid", "tokocrypto", "bitget", "mexc", "bitmart"];

console.log(
  `[ReconcileCron] Starting — interval=${RECONCILE_INTERVAL_MS}ms, exchanges=${EXCHANGES.join(", ")}`,
);

// Run immediately on startup, then on interval
for (const exchange of EXCHANGES) {
  runReconcile(exchange);
}

setInterval(() => {
  for (const exchange of EXCHANGES) {
    runReconcile(exchange);
  }
}, RECONCILE_INTERVAL_MS);
