import { OkxServices } from '../services/okxServices';
import { postgresDb } from '../db/client';
import { trades } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import * as JSONbig from 'json-bigint';
import redis from '../db/redis';
import type { ExchangeExecutor, ExecutorContext, ExecutorResult } from './types';
import type { OkxOrder } from '../schemas/interfaces';
import type { Autotrader } from '../db/schema';

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

/**
 * OKX SWAP instruments use the format: BTC-USDT-SWAP
 */
function toOkxInstId(symbol: string): string {
  if (symbol.endsWith('-SWAP')) return symbol.toUpperCase();
  if (symbol.includes('_')) return symbol.replace('_', '-').toUpperCase() + '-SWAP';
  return symbol.replace(/(USDT|USDC|BTC|ETH|BNB)$/, '-$1').toUpperCase() + '-SWAP';
}

async function openPosition(ctx: ExecutorContext): Promise<ExecutorResult> {
  const { autotrader, action, exchange_user_id, overrides } = ctx;

  const instId = toOkxInstId(autotrader.symbol);
  const leverage = autotrader.leverage;
  const leverage_type = (autotrader.leverage_type || 'ISOLATED') as 'ISOLATED' | 'CROSS';
  const position_type = action === 'BUY' ? 'long' : 'short';
  const size = computeSize(autotrader, overrides);
  const order_type = overrides.order_type ?? 'market';
  const isMarket = order_type === 'market';

  await redis.xadd(
    'ws-control:okx', '*',
    'op', 'open',
    'userId', String(exchange_user_id),
    'contract', instId,
  );

  const orderPayload: OkxOrder = {
    instId,
    tdMode: leverage_type.toLowerCase(), // 'isolated' or 'cross'
    side: position_type === 'long' ? 'buy' : 'sell',
    posSide: position_type,
    ordType: order_type,
    sz: String(size),
    reduceOnly: false,
  };

  if (!isMarket && overrides.price) {
    orderPayload.px = String(overrides.price);
  }

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
    console.error('[OkxExecutor] placeOrder failed:', errMsg);
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
    console.error('[OkxExecutor] Failed to persist trade to DB:', err);
  }

  return {
    success: true,
    exchange_order_id: orderId,
    raw: res,
  };
}

async function closePosition(ctx: ExecutorContext): Promise<ExecutorResult> {
  const { autotrader } = ctx;
  const instId = toOkxInstId(autotrader.symbol);

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
        console.error('[OkxExecutor] closePosition failed:', errMsg);
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
 * Compute contract size (number of contracts) for OKX SWAP instruments.
 * Formula: floor((capital * leverage) / (price * contract_value_multiplier))
 * - capital = initial_investment (USDT margin allocated)
 * - price = market_price from signal (current price sent by TradingView)
 * - contract_value_multiplier = ctVal from OKX instrument spec (base asset per contract)
 * Errors loudly if either required field is missing — never silently falls back to wrong sizing.
 */
function computeSize(autotrader: Autotrader, overrides: import('./types').SignalOverrides): number {
  const multiplier = autotrader.contract_value_multiplier;
  if (!multiplier || Number(multiplier) <= 0) {
    throw new Error(
      `[OkxExecutor] contract_value_multiplier is not set on autotrader ${autotrader.id} (${autotrader.symbol}). ` +
      `Set it to the OKX ctVal for this instrument before trading.`
    );
  }
  const price = overrides.order_type === 'limit' ? overrides.price : overrides.market_price;
  if (!price || price <= 0) {
    throw new Error(
      `[OkxExecutor] price is required for contract sizing. ` +
      `For market orders send market_price in the signal payload; for limit orders send price.`
    );
  }
  const capital = Number(autotrader.initial_investment);
  const leverage = autotrader.leverage;
  return Math.floor((capital * leverage) / (price * Number(multiplier)));
}
