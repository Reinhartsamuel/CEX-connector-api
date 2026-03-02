import { GateServices } from '../services/gateServices';
import { postgresDb } from '../db/client';
import { trades } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import * as JSONbig from 'json-bigint';
import redis from '../db/redis';
import type { ExchangeExecutor, ExecutorContext, ExecutorResult } from './types';
import type { GateFuturesOrder } from '../schemas/interfaces';

export const GateExecutor: ExchangeExecutor = {
  async execute(ctx: ExecutorContext): Promise<ExecutorResult> {
    const { autotrader, exchange_user_id, encrypted_api_key, encrypted_api_secret, action } = ctx;

    GateServices.initialize(ctx.api_key, ctx.api_secret);

    try {
      if (action === 'CLOSE') {
        return await closePosition(ctx);
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

async function openPosition(ctx: ExecutorContext): Promise<ExecutorResult> {
  const { autotrader, action, exchange_user_id, encrypted_api_key, encrypted_api_secret } = ctx;

  const contract = autotrader.symbol; // e.g. BTC_USDT
  const leverage = autotrader.leverage;
  const leverage_type = (autotrader.leverage_type || 'ISOLATED') as 'ISOLATED' | 'CROSS';
  const position_type = action === 'BUY' ? 'long' : 'short';
  const size = computeSize(autotrader);

  // Set leverage and margin mode from autotrader config
  await GateServices.updateLeverage(contract, leverage);
  await GateServices.updateMarginMode(contract, leverage_type);

  // Gate.io: short = negative size
  const sizeForOrder = position_type === 'short' ? -Math.abs(size) : Math.abs(size);

  const orderPayload: GateFuturesOrder = {
    contract,
    size: sizeForOrder,
    price: '0',   // always market for webhook signals
    tif: 'ioc',   // immediate-or-cancel = market execution
    iceberg: 0,
    reduce_only: false,
    auto_size: '',
    settle: 'usdt',
  };

  const resPlaceOrder = await GateServices.placeFuturesOrder(orderPayload);

  // Cache position in Redis for the WS worker
  if (resPlaceOrder?.finish_as === 'filled') {
    const positionKey = `${resPlaceOrder.contract}:dual_${position_type}`;
    await redis.hset(
      `user:${resPlaceOrder.user}:positions`,
      positionKey,
      JSON.stringify(resPlaceOrder),
    );
  }

  // Trigger WS subscription for order updates
  await redis.hset(
    `gate:creds:${exchange_user_id}`,
    'apiKey', encrypted_api_key,
    'apiSecret', encrypted_api_secret,
  );
  await redis.publish('ws-control', JSON.stringify({
    op: 'open',
    userId: String(exchange_user_id),
    contract,
  }));

  // Persist trade to DB
  try {
    const tradeStatus =
      resPlaceOrder?.status === 'finished' &&
      resPlaceOrder?.finish_as === 'filled' &&
      resPlaceOrder?.left === 0
        ? 'waiting_targets'
        : resPlaceOrder?.status;

    await postgresDb.insert(trades).values({
      user_id: autotrader.user_id,
      exchange_id: autotrader.exchange_id,
      autotrader_id: autotrader.id,
      trade_id: resPlaceOrder.id.toString(),
      order_id: resPlaceOrder.id.toString(),
      open_order_id: resPlaceOrder.id.toString(),
      contract: resPlaceOrder.contract,
      position_type,
      market_type: 'market',
      size: resPlaceOrder.size,
      leverage,
      leverage_type: leverage_type,
      status: tradeStatus,
      price: '0',
      reduce_only: false,
      is_tpsl: false,
      take_profit_enabled: false,
      stop_loss_enabled: false,
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

async function closePosition(ctx: ExecutorContext): Promise<ExecutorResult> {
  const { autotrader } = ctx;
  const contract = autotrader.symbol;

  // Find all open trades for this autotrader/contract
  const running_trades = await postgresDb.query.trades.findMany({
    where: and(
      eq(trades.autotrader_id, autotrader.id),
      eq(trades.contract, contract),
      eq(trades.status, 'waiting_targets'),
    ),
  });

  const results = await Promise.all(
    running_trades.map(async (trade) => {
      const closePayload: GateFuturesOrder = {
        contract,
        size: parseFloat(trade.size) * -1,
        price: '0',
        tif: 'ioc',
        iceberg: 0,
        reduce_only: true,
        auto_size: '',
        settle: 'usdt',
      };
      const res = await GateServices.placeFuturesOrder(closePayload);

      if (res?.status === 'finished' && res?.finish_as === 'filled' && res?.left === 0) {
        await postgresDb.update(trades).set({
          status: 'closed',
          close_order_id: res.id,
          pnl: res.pnl,
          pnl_margin: res.pnl_margin,
          closed_at: new Date(),
        }).where(eq(trades.id, trade.id));
      }

      return res;
    }),
  );

  return {
    success: true,
    raw: results,
  };
}

/**
 * Compute contract size (number of contracts) from the autotrader's capital setting.
 * Gate.io futures size = number of contracts (each contract = 1 unit of base asset by default).
 * For now we use initial_investment as the contract count directly.
 * TODO: factor in current price and contract multiplier for USD-denominated sizing.
 */
function computeSize(autotrader: typeof autotrader): number {
  return Math.floor(Number(autotrader.initial_investment));
}
