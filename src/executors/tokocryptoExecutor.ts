import { TokocryptoServices } from '../services/tokocryptoServices';
import { postgresDb } from '../db/client';
import { trades } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import redis from '../db/redis';
import type { ExchangeExecutor, ExecutorContext, ExecutorResult, SignalOverrides } from './types';
import type { Autotrader } from '../db/schema';

export const TokocryptoExecutor: ExchangeExecutor = {
  async execute(ctx: ExecutorContext): Promise<ExecutorResult> {
    const { action } = ctx;

    TokocryptoServices.initialize(ctx.api_key, ctx.api_secret, 'future');

    try {
      if (action === 'CLOSE') {
        return await closePosition(ctx);
      }
      if (action === 'BUY' || action === 'SELL') {
        return await openPosition(ctx);
      }
      return { success: false, error: `Unsupported action: ${action}` };
    } finally {
      TokocryptoServices.clearCredentials();
    }
  },
};

async function openPosition(ctx: ExecutorContext): Promise<ExecutorResult> {
  const { autotrader, action, exchange_user_id, overrides } = ctx;

  const contract = autotrader.symbol;
  const leverage = autotrader.leverage;
  const leverage_type = (autotrader.leverage_type || 'ISOLATED') as 'ISOLATED' | 'CROSS';
  const position_type = action === 'BUY' ? 'long' : 'short';
  const size = computeSize(autotrader, overrides);
  const order_type = overrides.order_type ?? 'market';
  const isMarket = order_type === 'market';

  await redis.xadd(
    'ws-control:tokocrypto', '*',
    'op', 'open',
    'userId', String(exchange_user_id),
    'contract', contract,
  );

  // Set leverage and margin mode in parallel before placing the order
  await Promise.all([
    TokocryptoServices.updateLeverage(contract, leverage),
    TokocryptoServices.updateMarginMode(contract, leverage_type),
  ]);

  const res = await TokocryptoServices.placeOrder({
    contract,
    position_type,
    market_type: order_type,
    size,
    price: isMarket ? undefined : (overrides.price ?? 0),
    reduce_only: false,
    take_profit: overrides.take_profit,
    stop_loss: overrides.stop_loss,
  });

  if (!res?.id) {
    const errMsg = res?.message || (res as any)?.info?.msg || JSON.stringify(res);
    console.error('[TokocryptoExecutor] placeOrder failed:', errMsg);
    return { success: false, error: `Tokocrypto order rejected: ${errMsg}` };
  }

  const ccxtStatus: string = res.status ?? '';
  // 'closed' from CCXT means filled for market orders; 'open' means pending for limit
  const tradeStatus = TokocryptoServices.mapCcxtStatusToDb(ccxtStatus, order_type);

  try {
    await postgresDb.insert(trades).values({
      user_id: autotrader.user_id,
      exchange_id: autotrader.exchange_id,
      autotrader_id: autotrader.id,
      trade_id: String(res.id),
      order_id: String(res.id),
      open_order_id: String(res.id),
      contract,
      position_type,
      market_type: order_type,
      size: String(size),
      leverage,
      leverage_type,
      status: tradeStatus,
      price: isMarket ? '0' : String(overrides.price ?? 0),
      open_fill_price: res.average ? String(res.average) : undefined,
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
    console.error('[TokocryptoExecutor] Failed to persist trade to DB:', err);
  }

  return {
    success: true,
    exchange_order_id: String(res.id),
    raw: res,
  };
}

async function closePosition(ctx: ExecutorContext): Promise<ExecutorResult> {
  const { autotrader } = ctx;
  const contract = autotrader.symbol;

  const running_trades = await postgresDb.query.trades.findMany({
    where: and(
      eq(trades.autotrader_id, autotrader.id),
      eq(trades.contract, contract),
      eq(trades.status, 'waiting_targets'),
    ),
  });

  const orderResults = await Promise.all(
    running_trades.map(async (trade) => {
      const closePositionType = trade.position_type === 'long' ? 'short' : 'long';
      try {
        const res = await TokocryptoServices.placeOrder({
          contract,
          position_type: closePositionType as 'long' | 'short',
          market_type: 'market',
          size: Math.abs(parseFloat(trade.size) || 0),
          reduce_only: true,
        });
        return { trade, res };
      } catch (err: any) {
        console.error('[TokocryptoExecutor] closePosition failed:', err.message);
        return { trade, res: null };
      }
    }),
  );

  const filledResults = orderResults.filter(
    ({ res }: { res: any }) => res?.id && res?.status === 'closed',
  );

  if (filledResults.length > 0) {
    await postgresDb.transaction(async (tx) => {
      for (const { trade, res } of filledResults) {
        await tx.update(trades).set({
          status: 'closed',
          close_order_id: String(res.id),
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
 * Compute order quantity (base asset amount) for Tokocrypto/Binance Futures.
 * Binance sz = base asset quantity (e.g. BTC), not contracts — no multiplier needed.
 * Formula: floor((capital * leverage) / price)
 * Errors loudly if price is missing — never silently falls back to wrong sizing.
 */
function computeSize(autotrader: Autotrader, overrides: SignalOverrides): number {
  const price = overrides.order_type === 'limit' ? overrides.price : overrides.market_price;
  if (!price || price <= 0) {
    throw new Error(
      `[TokocryptoExecutor] price is required for sizing. ` +
      `For market orders send market_price in the signal payload; for limit orders send price.`
    );
  }
  const capital = Number(autotrader.initial_investment);
  const leverage = autotrader.leverage;
  return Math.floor((capital * leverage) / price);
}
