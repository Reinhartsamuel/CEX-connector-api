import { GateServices } from '../services/gateServices';
import { postgresDb } from '../db/client';
import { trades } from '../db/schema';
import type { Autotrader } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import * as JSONbig from 'json-bigint';
import redis from '../db/redis';
import type { ExchangeExecutor, ExecutorContext, ExecutorResult } from './types';
import type { GateFuturesOrder, GateTriggerPriceOrder } from '../schemas/interfaces';
import { getOrderType } from '../utils/getOrderType';
import { getTriggerRule } from '../utils/getTriggerRule';
import { mapPriceType } from '../utils/mapPriceType';
import { waitForWsReady } from '../utils/wsReady';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export const GateExecutor: ExchangeExecutor = {
  async execute(ctx: ExecutorContext): Promise<ExecutorResult> {
    const { autotrader, exchange_user_id, action } = ctx;

    GateServices.initialize(ctx.api_key, ctx.api_secret);

    try {
      if (action === 'CLOSE') {
        return await closePositionAtMarketPrice(ctx);
      }
      if (action === 'BUY' || action === 'SELL') {
        return await openPosition(ctx);
      }

      return { success: false, error: `Unsupported action: ${action}` };
    } finally {
      GateServices.clearCredentials();
    }
  },
};

/**
 * Gate.io futures API requires underscore-separated symbols: BTC_USDT, not BTCUSDT.
 * Normalizes any common variant to that format.
 */
function toGateContract(symbol: string): string {
  // Already correct
  if (symbol.includes('_')) return symbol.toUpperCase();
  // BTCUSDT → BTC_USDT (matches USDT, USDC, BTC, ETH suffixes)
  return symbol.replace(/(USDT|USDC|BTC|ETH|BNB)$/, '_$1').toUpperCase();
}

async function openPosition(ctx: ExecutorContext): Promise<ExecutorResult> {
  const { autotrader, action, exchange_user_id, overrides } = ctx;

  const contract = toGateContract(autotrader.symbol);
  const leverage = autotrader.leverage;
  const leverage_type = (autotrader.leverage_type || 'ISOLATED') as 'ISOLATED' | 'CROSS';
  const position_type = action === 'BUY' ? 'long' : 'short';
  const size = computeSize(autotrader, overrides);

  // Resolve order type and price from signal override, defaulting to market
  const order_type = overrides.order_type ?? 'market';
  const isMarket = order_type === 'market';
  const priceStr = isMarket ? '0' : String(overrides.price ?? 0);
  const tif = isMarket ? 'ioc' : 'gtc';

  // ---- Step 1: Ensure WS worker is connected BEFORE placing the order ----
  // This prevents the race condition where market orders fill instantly
  // before the WS worker has subscribed to order/position events.
  // Worker decrypts credentials from DB via KMS — no plaintext in Redis.
  await redis.xadd(
    'ws-control:gate', '*',
    'op', 'open',
    'userId', String(exchange_user_id),
    'contract', contract,
  );

  // Wait for the worker to signal it's connected and subscribed (5s timeout).
  // On timeout we proceed anyway — the reconciliation snapshot will catch up.
  await waitForWsReady(REDIS_URL, 'gate', String(exchange_user_id), 5000);

  // ---- Step 2: Set leverage and margin mode in parallel ----
  await Promise.all([
    GateServices.updateLeverage(contract, leverage),
    GateServices.updateMarginMode(contract, leverage_type),
  ]);

  // ---- Step 3: Place the order (WS is now listening) ----
  const sizeForOrder = position_type === 'short' ? -Math.abs(size) : Math.abs(size);

  const orderPayload: GateFuturesOrder = {
    contract,
    size: sizeForOrder,
    price: priceStr,
    tif,
    iceberg: 0,
    reduce_only: false,
    auto_size: '',
    settle: 'usdt',
  };

  const resPlaceOrder = await GateServices.placeFuturesOrder(orderPayload);

  // Gate returns an error-shaped object on failure instead of throwing
  if (!resPlaceOrder?.id) {
    const errMsg = resPlaceOrder?.message || resPlaceOrder?.label || JSON.stringify(resPlaceOrder);
    console.error('[GateExecutor] placeFuturesOrder failed:', errMsg);
    return { success: false, error: `Gate order rejected: ${errMsg}` };
  }

  // Cache position in Redis for the WS worker
  if (resPlaceOrder?.finish_as === 'filled') {
    const positionKey = `${resPlaceOrder.contract}:dual_${position_type}`;
    await redis.hset(
      `user:${resPlaceOrder.user}:positions`,
      positionKey,
      JSON.stringify(resPlaceOrder),
    );
  }

  // Place TP/SL trigger orders only once the entry is filled (market) or always (limit — Gate handles trigger internally)
  const orderFilled = resPlaceOrder?.finish_as === 'filled';
  const autoSize = position_type === 'long' ? 'close_long' : 'close_short';
  const gateOrderType = getOrderType(position_type); // e.g. 'close_long_position'
  const initialPrice = gateOrderType.includes('position') ? '0' : priceStr;

  if ((isMarket ? orderFilled : true) && overrides.take_profit?.enabled) {
    const tpPayload: GateTriggerPriceOrder = {
      initial: {
        contract,
        price: initialPrice,
        tif,
        auto_size: autoSize,
        size: 0,
        reduce_only: true,
      },
      trigger: {
        strategy_type: 0,
        price_type: mapPriceType(overrides.take_profit.price_type),
        price: overrides.take_profit.price,
        rule: getTriggerRule(position_type, true),
      },
      order_type: isMarket ? gateOrderType : undefined,
    };
    await GateServices.triggerPriceOrder(tpPayload);
  }

  if ((isMarket ? orderFilled : true) && overrides.stop_loss?.enabled) {
    const slPayload: GateTriggerPriceOrder = {
      initial: {
        contract,
        price: initialPrice,
        tif,
        auto_size: autoSize,
        size: 0,
        reduce_only: true,
      },
      trigger: {
        strategy_type: 0,
        price_type: mapPriceType(overrides.stop_loss.price_type),
        price: overrides.stop_loss.price,
        rule: getTriggerRule(position_type, false),
      },
      order_type: isMarket ? gateOrderType : undefined,
    };
    await GateServices.triggerPriceOrder(slPayload);
  }

  // Persist trade to DB
  try {
    const orderFilled =
      resPlaceOrder?.status === 'finished' &&
      resPlaceOrder?.finish_as === 'filled' &&
      resPlaceOrder?.left === 0;

    const tradeStatus = orderFilled ? 'waiting_targets' : resPlaceOrder?.status;

    await postgresDb.insert(trades).values({
      user_id: autotrader.user_id,
      exchange_id: autotrader.exchange_id,
      autotrader_id: autotrader.id,
      trade_id: resPlaceOrder.id.toString(),
      order_id: resPlaceOrder.id.toString(),
      open_order_id: resPlaceOrder.id.toString(),
      contract: resPlaceOrder.contract,
      position_type,
      market_type: order_type,
      size: resPlaceOrder.size,
      leverage,
      leverage_type,
      status: tradeStatus,
      price: priceStr,
      // For market orders: Gate returns fill_price and finish_time in the same REST response
      open_fill_price: orderFilled ? (resPlaceOrder.fill_price ?? resPlaceOrder.price) : undefined,
      open_filled_at: orderFilled && resPlaceOrder.finish_time ? Math.floor(Number(resPlaceOrder.finish_time)) : undefined,
      reduce_only: false,
      is_tpsl: false,
      take_profit_enabled: overrides.take_profit?.enabled ?? false,
      take_profit_price: overrides.take_profit?.enabled ? Number(overrides.take_profit.price) : 0,
      take_profit_price_type: overrides.take_profit?.enabled ? overrides.take_profit.price_type : '',
      stop_loss_enabled: overrides.stop_loss?.enabled ?? false,
      stop_loss_price: overrides.stop_loss?.enabled ? Number(overrides.stop_loss.price) : 0,
      stop_loss_price_type: overrides.stop_loss?.enabled ? overrides.stop_loss.price_type : '',
      metadata: JSON.parse(JSONbig.stringify(resPlaceOrder)),
    } as any);
  } catch (err) {
    console.error('[GateExecutor] Failed to persist trade to DB:', err);
  }

  return {
    success: true,
    exchange_order_id: resPlaceOrder?.id?.toString(),
    raw: resPlaceOrder,
  };
}

async function closePositionAtMarketPrice(ctx: ExecutorContext): Promise<ExecutorResult> {
  const { autotrader } = ctx;
  const contract = toGateContract(autotrader.symbol);

  // Find all open trades for this autotrader/contract
  const running_trades = await postgresDb.query.trades.findMany({
    where: and(
      eq(trades.autotrader_id, autotrader.id),
      eq(trades.contract, contract),
      eq(trades.status, 'waiting_targets'),
    ),
  });

  // Place all close orders on the exchange first
  const orderResults = await Promise.all(
    running_trades.map(async (trade) => {
      const closePayload: GateFuturesOrder = {
        contract,
        size: (parseFloat(trade.size) || 0) * -1,
        price: '0',
        tif: 'ioc',
        iceberg: 0,
        reduce_only: true,
        auto_size: '',
        settle: 'usdt',
      };
      const res = await GateServices.placeFuturesOrder(closePayload);

      if (!res?.id) {
        const errMsg = res?.message || res?.label || JSON.stringify(res);
        console.error('[GateExecutor] closePositionAtMarketPrice placeFuturesOrder failed:', errMsg);
      }

      return { trade, res };
    }),
  );

  // Batch all DB updates in a single transaction for atomicity
  const filledResults = orderResults.filter(
    ({ res }: { res: any }) => res?.status === 'finished' && res?.finish_as === 'filled' && res?.left === 0,
  );

  if (filledResults.length > 0) {
    await postgresDb.transaction(async (tx) => {
      for (const { trade, res } of filledResults) {
        await tx.update(trades).set({
          status: 'closed',
          close_order_id: res.id,
          pnl: res.pnl,
          pnl_margin: res.pnl_margin,
          closed_at: new Date(),
        }).where(eq(trades.id, trade.id));
      }
    });
  }

  const results = orderResults.map(({ res }: { res: any }) => res);

  return {
    success: true,
    raw: results,
  };
}

/**
 * Compute contract size (number of contracts) for Gate.io futures.
 * Formula: floor((capital * leverage) / (price * contract_value_multiplier))
 * - capital = initial_investment (USDT margin allocated)
 * - price = market_price from signal (current mark/last price sent by TradingView)
 * - contract_value_multiplier = quanto_multiplier from Gate contract spec (coins per contract)
 * Errors loudly if either required field is missing — never silently falls back to wrong sizing.
 */
function computeSize(autotrader: Autotrader, overrides: import('./types').SignalOverrides): number {
  const multiplier = autotrader.contract_value_multiplier;
  if (!multiplier || Number(multiplier) <= 0) {
    throw new Error(
      `[GateExecutor] contract_value_multiplier is not set on autotrader ${autotrader.id} (${autotrader.symbol}). ` +
      `Set it to the Gate quanto_multiplier for this contract before trading.`
    );
  }
  const price = overrides.order_type === 'limit' ? overrides.price : overrides.market_price;
  if (!price || price <= 0) {
    throw new Error(
      `[GateExecutor] price is required for contract sizing. ` +
      `For market orders send market_price in the signal payload; for limit orders send price.`
    );
  }
  const capital = Number(autotrader.initial_investment);
  const leverage = autotrader.leverage;
  return Math.floor((capital * leverage) / (price * Number(multiplier)));
}
