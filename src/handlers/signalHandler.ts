import { Context } from 'hono';
import { z } from 'zod';
import { postgresDb } from '../db/client';
import { autotraders, exchanges } from '../db/schema';
import { eq } from 'drizzle-orm';
import { GateHandler } from './gate/gateHandler';
import { getExecutor } from '../executors/registry';
import type { SignalAction } from '../executors/types';

const signalSchema = z.object({
  token: z.string().min(1),
  action: z.enum(['BUY', 'SELL', 'CLOSE', 'CANCEL']),
});

export const SignalHandler = {
  /**
   * POST /webhook/signal
   *
   * Minimal public endpoint — no JWT. Authenticated via per-autotrader webhook_token.
   * TradingView alert payload:
   *   { "token": "<webhook_token>", "action": "BUY" | "SELL" | "CLOSE" | "CANCEL" }
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

    // 7. Execute
    const result = await executor.execute({
      autotrader,
      exchange,
      api_key: credentials.api_key,
      api_secret: credentials.api_secret,
      exchange_user_id: credentials.exchange_user_id,
      encrypted_api_key: credentials.encrypted_api_key,
      encrypted_api_secret: credentials.encrypted_api_secret,
      action: body.action as SignalAction,
    });

    const latency_ms = Date.now() - start;

    if (!result.success) {
      return c.json({ error: result.error, latency_ms }, 500);
    }

    return c.json({
      ok: true,
      action: body.action,
      exchange: exchange.exchange_title,
      autotrader_id: autotrader.id,
      symbol: autotrader.symbol,
      exchange_order_id: result.exchange_order_id,
      latency_ms,
    });
  },
};
