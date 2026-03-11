import { Context } from 'hono';
import { z } from 'zod';
import { postgresDb } from '../db/client';
import { autotraders, exchanges } from '../db/schema';
import { eq } from 'drizzle-orm';
import { GateHandler } from './gate/gateHandler';
import { getExecutor } from '../executors/registry';
import type { SignalAction } from '../executors/types';

const tpSlSchema = z.object({
  enabled: z.boolean(),
  price: z.string(),
  price_type: z.enum(['mark', 'last', 'index']),
});

const signalSchema = z.object({
  token: z.string().min(1),
  action: z.enum(['BUY', 'SELL', 'CLOSE', 'CANCEL']),

  // Optional overrides — if omitted, executor uses autotrader config defaults
  order_type: z.enum(['market', 'limit']).optional(),
  price: z.number().optional(),
  take_profit: tpSlSchema.optional(),
  stop_loss: tpSlSchema.optional(),
}).refine(
  (data) => {
    // price is required when order_type = limit on BUY/SELL
    if (data.order_type === 'limit' && (data.action === 'BUY' || data.action === 'SELL')) {
      return data.price !== undefined && data.price > 0;
    }
    return true;
  },
  { message: 'price is required and must be > 0 when order_type is limit', path: ['price'] },
);

export const SignalHandler = {
  /**
   * POST /webhook/signal
   *
   * Minimal public endpoint — no JWT. Authenticated via per-autotrader webhook_token.
   * TradingView alert payload (all fields except token+action are optional overrides):
   *   { "token": "...", "action": "BUY"|"SELL"|"CLOSE"|"CANCEL",
   *     "order_type": "market"|"limit", "price": 65000,
   *     "take_profit": { "enabled": true, "price": "68000", "price_type": "mark" },
   *     "stop_loss":   { "enabled": true, "price": "62000", "price_type": "mark" } }
   */
  handleSignal: async function (c: Context) {
    const start = Date.now();

    // 1. Parse & validate body
    let body: z.infer<typeof signalSchema>;
    try {
      body = signalSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: 'Invalid payload', detail: (err as Error).message }, 400);
    }

    // 2. Resolve autotrader by webhook_token
    const autotrader = await postgresDb.query.autotraders.findFirst({
      where: eq(autotraders.webhook_token, body.token),
    });

    if (!autotrader) {
      // Return 404 — don't hint whether token exists or not
      return c.json({ error: 'Invalid token' }, 404);
    }

    // 3. Guard: only process signals for active autotraders
    if (autotrader.status !== 'active') {
      return c.json({
        error: 'Autotrader is not active',
        status: autotrader.status,
      }, 422);
    }

    // 4. Load exchange row
    const exchange = await postgresDb.query.exchanges.findFirst({
      where: eq(exchanges.id, autotrader.exchange_id),
    });

    if (!exchange) {
      return c.json({ error: 'Exchange configuration not found' }, 500);
    }

    // 5. Decrypt credentials via KMS
    let credentials: Awaited<ReturnType<typeof GateHandler.unwrapCredentials>>;
    try {
      credentials = await GateHandler.unwrapCredentials(autotrader.exchange_id);
    } catch (err) {
      console.error('[SignalHandler] KMS decrypt failed:', err);
      return c.json({ error: 'Failed to load exchange credentials' }, 500);
    }

    // 6. Get the right executor for this exchange
    let executor;
    try {
      executor = getExecutor(exchange.exchange_title);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 422);
    }

    // 7. Respond immediately so TradingView doesn't time out, execute in background
    const execCtx = {
      autotrader,
      exchange,
      api_key: credentials.api_key,
      api_secret: credentials.api_secret,
      exchange_user_id: credentials.exchange_user_id,
      action: body.action as SignalAction,
      overrides: {
        order_type: body.order_type,
        price: body.price,
        take_profit: body.take_profit,
        stop_loss: body.stop_loss,
      },
    };

    executor.execute(execCtx).then((result) => {
      if (!result.success) {
        console.error('[SignalHandler] Executor failed:', result.error);
      } else {
        console.log('[SignalHandler] Executed:', body.action, autotrader.symbol, result.exchange_order_id);
      }
    }).catch((err) => {
      console.error('[SignalHandler] Executor threw:', err);
    });

    const latency_ms = Date.now() - start;
    console.log('[SignalHandler] Processed:', body.action, autotrader.symbol, latency_ms);
    
    return c.json({
      ok: true,
      action: body.action,
      exchange: exchange.exchange_title,
      autotrader_id: autotrader.id,
      symbol: autotrader.symbol,
      latency_ms,
    });
  },
};
