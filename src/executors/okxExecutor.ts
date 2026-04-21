import { OkxServices } from '../services/okxServices';
import { postgresDb } from '../db/client';
import { trades } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import * as JSONbig from 'json-bigint';
import redis from '../db/redis';
import type { ExchangeExecutor, ExecutorContext, ExecutorResult, SignalOverrides } from './types';
import type { OkxOrder } from '../schemas/interfaces';
import type { Autotrader } from '../db/schema';
import { createLogger } from '../utils/logger';
import { exchangeErrorsTotal } from '../utils/metrics';

const log = createLogger({ exchange: 'okx', process: 'executor' });

export const OkxExecutor: ExchangeExecutor = {
  async execute(ctx: ExecutorContext): Promise<ExecutorResult> {
    const { action } = ctx;

    OkxServices.initialize(ctx.api_key, ctx.api_secret, ctx.api_passphrase!);

    try {
      if (action === 'CLOSE') {
        return await closePosition(ctx);
      }
      if (action === 'BUY' || action === 'SELL') {
        return await openPosition(ctx);
      }
      return { success: false, error: `Unsupported action: ${action}` };
    } finally {
      OkxServices.clearCredentials();
    }
  },
};

async function openPosition(ctx: ExecutorContext): Promise<ExecutorResult> {
  const { autotrader, action, exchange_user_id, overrides } = ctx;

  // Symbol is already stored in exchange-native format (e.g., BTC-USDT-SWAP or BTC-USDT)
  const instId = autotrader.symbol;
  const leverage = autotrader.leverage;
  const leverage_type = (autotrader.leverage_type || 'ISOLATED') as 'ISOLATED' | 'CROSS';
  const position_type = action === 'BUY' ? 'long' : 'short';
  const isFutures = autotrader.market === 'futures';
  const size = computeSize(autotrader, overrides);
  const order_type = overrides.order_type ?? 'market';
  const isMarket = order_type === 'market';

  await redis.xadd(
    'ws-control', '*',
    'op', 'open',
    'exchange', 'okx',
    'userId', String(exchange_user_id),
    'contract', instId,
  );

  await redis.xadd(
    'ws-control:okx', '*',
    'op', 'open',
    'exchange', 'okx',
    'userId', String(exchange_user_id),
    'contract', instId,
  );

  // Build order payload with market-type aware fields
  const orderPayload: OkxOrder = {
    instId,
    tdMode: isFutures ? leverage_type.toLowerCase() : 'cash', // 'cash' for spot, 'isolated'/'cross' for futures
    side: position_type === 'long' ? 'buy' : 'sell',
    ordType: order_type,
    sz: String(size),
    reduceOnly: false,
  };

  // posSide only for futures/margin (not spot)
  if (isFutures) {
    orderPayload.posSide = position_type;
  }

  if (!isMarket && overrides.price) {
    orderPayload.px = String(overrides.price);
  }

  // Spot market buy special case: spend exact USDT amount using tgtCcy
  // Note: This would require a new field in SignalOverrides if needed in future

  // OKX supports inline TP/SL via attachAlgoOrds — both can share one object
  const algoOrd: Record<string, string> = {};
  if (overrides.take_profit?.enabled) {
    algoOrd.tpTriggerPx = overrides.take_profit.price;
    algoOrd.tpOrdPx = '-1'; // -1 = market order on trigger
    algoOrd.tpTriggerPxType = overrides.take_profit.price_type;
  }
  if (overrides.stop_loss?.enabled) {
    algoOrd.slTriggerPx = overrides.stop_loss.price;
    algoOrd.slOrdPx = '-1';
    algoOrd.slTriggerPxType = overrides.stop_loss.price_type;
  }
  if (Object.keys(algoOrd).length > 0) {
    orderPayload.attachAlgoOrds = [algoOrd];
  }

  const res = await OkxServices.placeOrder(orderPayload);

  if (res?.code !== '0' || !res?.data?.[0] || res.data[0].sCode !== '0') {
    const errMsg = res?.data?.[0]?.sMsg || res?.msg || JSON.stringify(res);
    exchangeErrorsTotal.inc({ exchange: 'okx', component: 'executor' });
    log.error({ errMsg }, 'placeOrder failed');
    return { success: false, error: `OKX order rejected: ${errMsg}` };
  }

  const orderId = res.data[0].ordId?.toString();
  // Market orders fill immediately; limit orders wait for price
  const tradeStatus = isMarket ? 'waiting_targets' : 'waiting_position';

  try {
    await postgresDb.insert(trades).values({
      user_id: autotrader.user_id,
      exchange_id: autotrader.exchange_id,
      autotrader_id: autotrader.id,
      trade_id: orderId,
      order_id: orderId,
      open_order_id: orderId,
      contract: instId,
      position_type,
      market_type: order_type,
      size: String(size),
      leverage,
      leverage_type,
      status: tradeStatus,
      price: isMarket ? '0' : String(overrides.price ?? 0),
      reduce_only: false,
      is_tpsl: false,
      take_profit_enabled: overrides.take_profit?.enabled ?? false,
      take_profit_price: overrides.take_profit?.enabled ? Number(overrides.take_profit.price) : 0,
      take_profit_price_type: overrides.take_profit?.enabled ? overrides.take_profit.price_type : '',
      stop_loss_enabled: overrides.stop_loss?.enabled ?? false,
      stop_loss_price: overrides.stop_loss?.enabled ? Number(overrides.stop_loss.price) : 0,
      stop_loss_price_type: overrides.stop_loss?.enabled ? overrides.stop_loss.price_type : '',
      metadata: JSON.parse(JSONbig.stringify(res)),
    } as any);
  } catch (err) {
    log.error({ err }, 'Failed to persist trade to DB');
  }

  return {
    success: true,
    exchange_order_id: orderId,
    raw: res,
  };
}

async function closePosition(ctx: ExecutorContext): Promise<ExecutorResult> {
  const { autotrader } = ctx;
  // Symbol is already stored in exchange-native format
  const instId = autotrader.symbol;

  const running_trades = await postgresDb.query.trades.findMany({
    where: and(
      eq(trades.autotrader_id, autotrader.id),
      eq(trades.contract, instId),
      eq(trades.status, 'waiting_targets'),
    ),
  });

  const orderResults = await Promise.all(
    running_trades.map(async (trade) => {
      const closePayload: OkxOrder = {
        instId,
        tdMode: (trade.leverage_type ?? 'ISOLATED').toLowerCase(),
        side: trade.position_type === 'long' ? 'sell' : 'buy',
        posSide: trade.position_type as string,
        ordType: 'market',
        sz: String(Math.abs(parseFloat(trade.size) || 0)),
        reduceOnly: true,
      };

      const res = await OkxServices.placeOrder(closePayload);
      if (res?.code !== '0' || res?.data?.[0]?.sCode !== '0') {
        const errMsg = res?.data?.[0]?.sMsg || res?.msg || JSON.stringify(res);
        exchangeErrorsTotal.inc({ exchange: 'okx', component: 'executor' });
        log.error({ errMsg }, 'closePosition failed');
      }
      return { trade, res };
    }),
  );

  const filledResults = orderResults.filter(
    ({ res }: { res: any }) => res?.code === '0' && res?.data?.[0]?.sCode === '0',
  );

  if (filledResults.length > 0) {
    await postgresDb.transaction(async (tx) => {
      for (const { trade, res } of filledResults) {
        await tx.update(trades).set({
          status: 'closed',
          close_order_id: res.data[0].ordId?.toString(),
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
 * Compute order size for OKX instruments.
 * 
 * For FUTURES/SWAP:
 *   - Returns NUMBER OF CONTRACTS
 *   - Formula: floor((capital * leverage) / (price * contract_value_multiplier))
 *   - contract_value_multiplier = ctVal from OKX (base asset per contract)
 * 
 * For SPOT:
 *   - Returns COIN AMOUNT (base currency quantity)
 *   - Formula: (capital * leverage) / price
 *   - No multiplier needed (sz = coin amount directly)
 * 
 * @param autotrader - Autotrader config with market type and multiplier
 * @param overrides - Signal overrides including price
 * @returns Size to use in OKX order (contracts for futures, coin amount for spot)
 */
function computeSize(autotrader: Autotrader, overrides: SignalOverrides): number {
  const { market } = autotrader;
  const multiplier = autotrader.contract_value_multiplier;
  const price = overrides.order_type === 'limit' ? overrides.price : overrides.market_price;
  const capital = Number(autotrader.initial_investment);
  const leverage = autotrader.leverage ?? 1;

  if (!price || price <= 0) {
    throw new Error(
      `[OkxExecutor] price is required for contract sizing. ` +
      `For market orders send market_price in the signal payload; for limit orders send price.`
    );
  }

  if (market === 'futures') {
    if (!multiplier || Number(multiplier) <= 0) {
      throw new Error(
        `[OkxExecutor] contract_value_multiplier is not set on autotrader ${autotrader.id} (${autotrader.symbol}). ` +
        `Ensure the autotrader was created with a valid multiplier from OKX /instruments API.`
      );
    }
    // FUTURES: return NUMBER OF CONTRACTS
    return Math.floor((capital * leverage) / (price * Number(multiplier)));
  }

  // SPOT: return COIN AMOUNT (base currency quantity)
  // No multiplier needed - OKX spot orders use coin amount directly in sz field
  return (capital * leverage) / price;
}
