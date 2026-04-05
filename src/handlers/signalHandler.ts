import { Context } from 'hono';
import { z } from 'zod';
import { postgresDb } from '../db/client';
import { autotraders, exchanges, webhooks, webhook_responses } from '../db/schema';
import { eq } from 'drizzle-orm';
import { GateHandler } from './gate/gateHandler';
import { OkxHandler } from './okx/okxHandler';
import { HyperliquidHandler } from './hyperliquid/hyperliquidHandler';
import { TokocryptoHandler } from './tokocrypto/tokocryptoHandler';
import { getExecutor } from '../executors/registry';
import type { SignalAction } from '../executors/types';

async function resolveCredentials(exchangeTitle: string, exchangeId: number) {
  switch (exchangeTitle.toLowerCase()) {
    case 'gate':
      return GateHandler.unwrapCredentials(exchangeId);
    case 'okx': {
      const c = await OkxHandler.unwrapCredentials(exchangeId);
      return { api_key: c.api_key, api_secret: c.api_secret, api_passphrase: c.api_passphrase, exchange_user_id: c.exchange_user_id };
    }
    case 'hyperliquid': {
      const c = await HyperliquidHandler.unwrapCredentials(exchangeId);
      return { api_key: c.wallet_address, api_secret: c.agent_private_key, exchange_user_id: c.exchange_user_id ?? c.wallet_address };
    }
    case 'tokocrypto':
      return TokocryptoHandler.unwrapCredentials(exchangeId);
    default:
      throw new Error(`No credential handler for exchange: "${exchangeTitle}"`);
  }
}

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
  market_price: z.number().positive().optional(), // current price from TradingView, used for contract sizing on market orders
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

    // 5. Record the webhook attempt now that we have user_id + exchange_id
    const [webhookRow] = await postgresDb.insert(webhooks).values({
      user_id: autotrader.user_id,
      exchange_id: autotrader.exchange_id,
      autotrader_id: autotrader.id,
      action: body.action,
      payload: body as unknown as Record<string, unknown>,
      status: 'pending',
      type: 'personal',
    }).returning({ id: webhooks.id });

    const markWebhook = async (status: string, error_message?: string) => {
      await postgresDb.update(webhooks)
        .set({ status, error_message: error_message ?? null, processed_at: new Date() })
        .where(eq(webhooks.id, webhookRow.id));
    };

    // 6. Decrypt credentials via KMS (dispatched per exchange type)
    let credentials: Awaited<ReturnType<typeof resolveCredentials>>;
    try {
      credentials = await resolveCredentials(exchange.exchange_title, autotrader.exchange_id);
    } catch (err) {
      console.error('[SignalHandler] KMS decrypt failed:', err);
      await markWebhook('failed', 'Failed to load exchange credentials');
      return c.json({ error: 'Failed to load exchange credentials' }, 500);
    }

    // 7. Get the right executor for this exchange
    let executor;
    try {
      executor = getExecutor(exchange.exchange_title);
    } catch (err) {
      await markWebhook('failed', (err as Error).message);
      return c.json({ error: (err as Error).message }, 422);
    }

    // 8. Respond immediately so TradingView doesn't time out, execute in background
    const execCtx = {
      autotrader,
      exchange,
      api_key: credentials.api_key,
      api_secret: credentials.api_secret,
      api_passphrase: (credentials as any).api_passphrase,
      exchange_user_id: credentials.exchange_user_id,
      action: body.action as SignalAction,
      overrides: {
        order_type: body.order_type,
        price: body.price,
        market_price: body.market_price,
        take_profit: body.take_profit,
        stop_loss: body.stop_loss,
      },
    };

    const safeJson = (v: unknown): Record<string, unknown> => {
      if (v == null) return {};
      try { return JSON.parse(JSON.stringify(v)); } catch { return {}; }
    };

    executor.execute(execCtx).then(async (result) => {
      if (!result.success) {
        console.error('[SignalHandler] Executor failed:', result.error);
        await Promise.all([
          markWebhook('failed', result.error),
          postgresDb.insert(webhook_responses).values({
            webhook_id: webhookRow.id,
            user_id: autotrader.user_id,
            exchange_id: autotrader.exchange_id,
            response_status: 422,
            response_body: safeJson(result.raw),
            error_message: result.error ?? null,
          }),
        ]);
      } else {
        console.log('[SignalHandler] Executed:', body.action, autotrader.symbol, result.exchange_order_id);
        await Promise.all([
          markWebhook('completed'),
          postgresDb.insert(webhook_responses).values({
            webhook_id: webhookRow.id,
            user_id: autotrader.user_id,
            exchange_id: autotrader.exchange_id,
            response_status: 200,
            response_body: safeJson(result.raw),
          }),
        ]);
      }
    }).catch(async (err) => {
      console.error('[SignalHandler] Executor threw:', err);
      const errMsg = (err as Error).message ?? String(err);
      await Promise.all([
        markWebhook('failed', errMsg),
        postgresDb.insert(webhook_responses).values({
          webhook_id: webhookRow.id,
          user_id: autotrader.user_id,
          exchange_id: autotrader.exchange_id,
          response_status: 500,
          response_body: {},
          error_message: errMsg,
        }),
      ]);
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
