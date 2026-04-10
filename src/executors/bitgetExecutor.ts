import { BitgetServices } from '../services/bitgetServices';
import { postgresDb } from '../db/client';
import { trades } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import redis from '../db/redis';
import type { ExchangeExecutor, ExecutorContext, ExecutorResult, SignalOverrides } from './types';
import type { Autotrader } from '../db/schema';
import { createLogger } from '../utils/logger';
import { exchangeErrorsTotal } from '../utils/metrics';

const log = createLogger({ exchange: 'bitget', process: 'executor' });

export const BitgetExecutor: ExchangeExecutor = {
  async execute(ctx: ExecutorContext): Promise<ExecutorResult> {
    const { action, api_passphrase } = ctx;

    BitgetServices.initialize(ctx.api_key, ctx.api_secret, api_passphrase!);

    try {
      if (action === 'CLOSE') {
        return await closePosition(ctx);
      }
      if (action === 'BUY' || action === 'SELL') {
        return await openPosition(ctx);
      }
      return { success: false, error: `Unsupported action: ${action}` };
    } finally {
      BitgetServices.clearCredentials();
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

  // Publish to Redis Stream for WS worker
  await redis.xadd(
    'ws-control:bitget', '*',
    'op', 'open',
    'userId', String(exchange_user_id),
    'contract', contract,
  );

  // Set leverage and margin mode in parallel before placing the order
  await Promise.all([
    BitgetServices.updateLeverage(contract, leverage),
    BitgetServices.updateMarginMode(contract, leverage_type),
  ]);

  const res = await BitgetServices.placeOrder({
    contract,
    position_type,
    market_type: order_type,
    size,
    price: isMarket ? undefined : String(overrides.price ?? 0),
    reduce_only: false,
  });

  if (!res?.id) {
    const errMsg = res?.message || (res as any)?.info?.msg || JSON.stringify(res);
    exchangeErrorsTotal.inc({ exchange: 'bitget', component: 'executor' });
    log.error({ errMsg }, 'placeOrder failed');
    return { success: false, error: `Bitget order rejected: ${errMsg}` };
  }

  const ccxtStatus: string = res.status ?? '';
  const tradeStatus = BitgetServices.mapCcxtStatusToDb(ccxtStatus, order_type);

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
      price: isMarket ? '0' : String(overrides.price ?? '0'),
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
    log.error({ err }, 'Failed to persist trade to DB');
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
        const res = await BitgetServices.placeOrder({
          contract,
          position_type: closePositionType as 'long' | 'short',
          market_type: 'market',
          size: Math.abs(parseFloat(trade.size) || 0),
          reduce_only: true,
        });
        return { trade, res };
      } catch (err: any) {
        exchangeErrorsTotal.inc({ exchange: 'bitget', component: 'executor' });
        log.error({ err }, 'closePosition failed');
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
 * Compute contract size (number of contracts) for Bitget futures.
 * Formula: floor((capital * leverage) / (price * contract_value_multiplier))
 * - capital = initial_investment (USDT margin allocated)
 * - price = market_price from signal (for market orders) or limit price
 * - contract_value_multiplier = quanto_multiplier from Bitget contract spec
 */
function computeSize(autotrader: Autotrader, overrides: SignalOverrides): number {
  const multiplier = autotrader.contract_value_multiplier;
  if (!multiplier || Number(multiplier) <= 0) {
    throw new Error(
      `[BitgetExecutor] contract_value_multiplier is not set on autotrader ${autotrader.id} (${autotrader.symbol}). ` +
      `Set it to the Bitget quanto_multiplier for this contract before trading.`
    );
  }
  const price = overrides.order_type === 'limit' ? overrides.price : overrides.market_price;
  if (!price || price <= 0) {
    throw new Error(
      `[BitgetExecutor] price is required for sizing. ` +
      `For market orders send market_price in the signal payload; for limit orders send price.`
    );
  }
  const capital = Number(autotrader.initial_investment);
  const leverage = autotrader.leverage;
  return Math.floor((capital * leverage) / (price * Number(multiplier)));
}