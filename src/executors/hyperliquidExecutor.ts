import { HyperliquidServices } from '../services/hyperliquidServices';
import { postgresDb } from '../db/client';
import { trades } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import redis from '../db/redis';
import type { ExchangeExecutor, ExecutorContext, ExecutorResult, SignalOverrides } from './types';
import type { Autotrader } from '../db/schema';

export const HyperliquidExecutor: ExchangeExecutor = {
  async execute(ctx: ExecutorContext): Promise<ExecutorResult> {
    const { action } = ctx;

    // api_secret = agent_private_key for Hyperliquid
    HyperliquidServices.initialize(ctx.api_secret);

    try {
      if (action === 'CLOSE') {
        return await closePosition(ctx);
      }
      if (action === 'BUY' || action === 'SELL') {
        return await openPosition(ctx);
      }
      return { success: false, error: `Unsupported action: ${action}` };
    } finally {
      HyperliquidServices.clearCredentials();
    }
  },
};

async function openPosition(ctx: ExecutorContext): Promise<ExecutorResult> {
  const { autotrader, action, exchange_user_id, overrides } = ctx;

  const symbol = autotrader.symbol;
  const leverage = autotrader.leverage;
  const leverage_type = (autotrader.leverage_type || 'ISOLATED') as 'ISOLATED' | 'CROSS';
  const position_type = action === 'BUY' ? 'long' : 'short';
  const order_type = overrides.order_type ?? 'market';
  const isMarket = order_type === 'market';

  await redis.xadd(
    'ws-control:hyperliquid', '*',
    'op', 'open',
    'userId', String(exchange_user_id),
    'userAddress', String(exchange_user_id), // Hyperliquid worker needs wallet address
    'contract', symbol,
  );

  // Step 1: Set leverage
  await HyperliquidServices.updateLeverage(symbol, leverage, leverage_type === 'CROSS');

  // Step 2: Get asset metadata for precision formatting
  const assetMeta = await HyperliquidServices.getAssetMetadata(symbol);
  const { szDecimals } = assetMeta;

  const rawSize = computeSize(autotrader, overrides);
  const formattedSize = parseFloat(HyperliquidServices.formatHyperliquidSize(rawSize, szDecimals));

  let formattedPrice = '0';
  if (!isMarket && overrides.price) {
    formattedPrice = HyperliquidServices.formatHyperliquidPrice(overrides.price, szDecimals);
  }

  // Step 3: Place entry order
  const res = await HyperliquidServices.placeOrder({
    contract: symbol,
    position_type,
    market_type: order_type,
    size: formattedSize,
    price: formattedPrice,
    reduce_only: false,
  });

  const statuses = res?.response?.data?.statuses;
  const firstStatus = statuses?.[0];
  const isFilled = !!firstStatus?.filled;
  const isResting = !!firstStatus?.resting;

  if (res?.status !== 'ok' || (!isFilled && !isResting)) {
    const errMsg = firstStatus?.error || JSON.stringify(res);
    console.error('[HyperliquidExecutor] placeOrder failed:', errMsg);
    return { success: false, error: `Hyperliquid order rejected: ${errMsg}` };
  }

  const orderId = (firstStatus?.filled?.oid ?? firstStatus?.resting?.oid)?.toString();
  // Market fills immediately; limit order waits for price
  const tradeStatus = isFilled ? 'waiting_targets' : 'waiting_position';

  // Step 4: TP/SL as separate reduce_only limit orders
  const closePositionType = position_type === 'long' ? 'short' : 'long';

  if ((isMarket ? isFilled : true) && overrides.take_profit?.enabled) {
    const tpPrice = Number(overrides.take_profit.price);
    const formattedTpPrice = HyperliquidServices.formatHyperliquidPrice(tpPrice, szDecimals);
    await HyperliquidServices.placeOrder({
      contract: symbol,
      position_type: closePositionType,
      market_type: 'limit',
      size: formattedSize,
      price: formattedTpPrice,
      reduce_only: true,
    }).catch((err) => console.error('[HyperliquidExecutor] TP order failed:', err));
  }

  if ((isMarket ? isFilled : true) && overrides.stop_loss?.enabled) {
    const slPrice = Number(overrides.stop_loss.price);
    const formattedSlPrice = HyperliquidServices.formatHyperliquidPrice(slPrice, szDecimals);
    await HyperliquidServices.placeOrder({
      contract: symbol,
      position_type: closePositionType,
      market_type: 'limit',
      size: formattedSize,
      price: formattedSlPrice,
      reduce_only: true,
    }).catch((err) => console.error('[HyperliquidExecutor] SL order failed:', err));
  }

  try {
    await postgresDb.insert(trades).values({
      user_id: autotrader.user_id,
      exchange_id: autotrader.exchange_id,
      autotrader_id: autotrader.id,
      trade_id: orderId,
      order_id: orderId,
      open_order_id: orderId,
      contract: symbol,
      position_type,
      market_type: order_type,
      size: String(formattedSize),
      leverage,
      leverage_type,
      status: tradeStatus,
      price: formattedPrice,
      open_fill_price: isFilled ? String(firstStatus.filled.avgPx ?? 0) : undefined,
      reduce_only: false,
      is_tpsl: false,
      take_profit_enabled: overrides.take_profit?.enabled ?? false,
      take_profit_price: overrides.take_profit?.enabled ? Number(overrides.take_profit.price) : 0,
      take_profit_price_type: overrides.take_profit?.enabled ? overrides.take_profit.price_type : '',
      stop_loss_enabled: overrides.stop_loss?.enabled ?? false,
      stop_loss_price: overrides.stop_loss?.enabled ? Number(overrides.stop_loss.price) : 0,
      stop_loss_price_type: overrides.stop_loss?.enabled ? overrides.stop_loss.price_type : '',
      metadata: res,
    } as any);
  } catch (err) {
    console.error('[HyperliquidExecutor] Failed to persist trade to DB:', err);
  }

  return {
    success: true,
    exchange_order_id: orderId,
    raw: res,
  };
}

async function closePosition(ctx: ExecutorContext): Promise<ExecutorResult> {
  const { autotrader } = ctx;
  const symbol = autotrader.symbol;

  const running_trades = await postgresDb.query.trades.findMany({
    where: and(
      eq(trades.autotrader_id, autotrader.id),
      eq(trades.contract, symbol),
      eq(trades.status, 'waiting_targets'),
    ),
  });

  const assetMeta = await HyperliquidServices.getAssetMetadata(symbol);
  const { szDecimals } = assetMeta;

  const orderResults = await Promise.all(
    running_trades.map(async (trade) => {
      const closePositionType = trade.position_type === 'long' ? 'short' : 'long';
      const size = parseFloat(
        HyperliquidServices.formatHyperliquidSize(Math.abs(parseFloat(trade.size) || 0), szDecimals),
      );

      const res = await HyperliquidServices.placeOrder({
        contract: symbol,
        position_type: closePositionType as 'long' | 'short',
        market_type: 'market',
        size,
        price: '0',
        reduce_only: true,
      });

      const statuses = res?.response?.data?.statuses;
      const filled = statuses?.[0]?.filled;
      if (!filled) {
        console.error('[HyperliquidExecutor] closePosition failed:', statuses?.[0]?.error || JSON.stringify(res));
      }
      return { trade, res, filled };
    }),
  );

  const filledResults = orderResults.filter(({ filled }) => !!filled);

  if (filledResults.length > 0) {
    await postgresDb.transaction(async (tx) => {
      for (const { trade } of filledResults) {
        await tx.update(trades).set({
          status: 'closed',
          closed_at: new Date(),
        }).where(eq(trades.id, trade.id));
      }
    });
  }

  return {
    success: true,
    raw: orderResults.map(({ res }) => res),
  };
}

/**
 * Compute order quantity (base asset amount) for Hyperliquid.
 * Hyperliquid sz = base asset quantity — no contract multiplier needed.
 * Formula: (capital * leverage) / price  (szDecimals precision applied by the caller via formatHyperliquidSize)
 * Errors loudly if price is missing — never silently falls back to wrong sizing.
 */
function computeSize(autotrader: Autotrader, overrides: SignalOverrides): number {
  const price = overrides.order_type === 'limit' ? overrides.price : overrides.market_price;
  if (!price || price <= 0) {
    throw new Error(
      `[HyperliquidExecutor] price is required for sizing. ` +
      `For market orders send market_price in the signal payload; for limit orders send price.`
    );
  }
  const capital = Number(autotrader.initial_investment);
  const leverage = autotrader.leverage;
  return (capital * leverage) / price;
}
