import { Context } from 'hono';
import { z } from 'zod';
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { postgresDb } from '../db/client';
import redis from '../db/redis';
import {
  autotraders,
  exchanges,
  trading_plan_keys,
  webhooks,
  webhook_responses,
} from '../db/schema';
import { GateHandler } from './gate/gateHandler';
import { OkxHandler } from './okx/okxHandler';
import { HyperliquidHandler } from './hyperliquid/hyperliquidHandler';
import { TokocryptoHandler } from './tokocrypto/tokocryptoHandler';
import { getExecutor } from '../executors/registry';
import type { SignalAction } from '../executors/types';
import { createLogger } from '../utils/logger';
import { tradesOpenedTotal, signalLatency, exchangeErrorsTotal } from '../utils/metrics';

const log = createLogger({ process: 'api', component: 'signal-handler' });

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
  order_type: z.enum(['market', 'limit']).optional(),
  price: z.coerce.number().optional(),
  market_price: z.coerce.number().positive().optional(),
  take_profit: tpSlSchema.optional(),
  stop_loss: tpSlSchema.optional(),
}).refine(
  (data) => {
    if (data.order_type === 'limit' && (data.action === 'BUY' || data.action === 'SELL')) {
      return data.price !== undefined && data.price > 0;
    }
    return true;
  },
  { message: 'price is required and must be > 0 when order_type is limit', path: ['price'] },
);

const planSignalSchema = z.object({
  key_id: z.coerce.number().int().positive(),
  secret: z.string().min(1),
  event_id: z.string().min(1).max(128).optional(),
  pair_symbol: z.string().min(1).optional(),
  pair_id: z.coerce.number().int().positive().optional(),
  action: z.enum(['BUY', 'SELL', 'CLOSE', 'CANCEL']),
  order_type: z.enum(['market', 'limit']).optional(),
  price: z.coerce.number().optional(),
  market_price: z.coerce.number().positive().optional(),
  take_profit: tpSlSchema.optional(),
  stop_loss: tpSlSchema.optional(),
}).refine(
  (data) => {
    if (data.order_type === 'limit' && (data.action === 'BUY' || data.action === 'SELL')) {
      return data.price !== undefined && data.price > 0;
    }
    return true;
  },
  { message: 'price is required and must be > 0 when order_type is limit', path: ['price'] },
);

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function safeEqualHex(expectedHex: string, actualHex: string): boolean {
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(actualHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function checkRateLimit(keyId: number, maxPerMinute: number): Promise<boolean> {
  const rlKey = `plan-key:${keyId}:minute:${Math.floor(Date.now() / 60000)}`;
  const count = await redis.incr(rlKey);
  if (count === 1) {
    await redis.expire(rlKey, 70);
  }
  return count <= maxPerMinute;
}

async function runBounded<T>(items: T[], worker: (item: T) => Promise<void>, concurrency: number): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = index;
      index += 1;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

function getOverridesFromBody(body: z.infer<typeof signalSchema> | z.infer<typeof planSignalSchema>) {
  return {
    order_type: body.order_type,
    price: body.price,
    market_price: body.market_price,
    take_profit: body.take_profit,
    stop_loss: body.stop_loss,
  };
}

function safeJson(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  try { return JSON.parse(JSON.stringify(v)); } catch { return {}; }
}

async function executeSignalForAutotrader(params: {
  autotrader: typeof autotraders.$inferSelect;
  action: SignalAction;
  payload: Record<string, unknown>;
  webhookType: 'personal' | 'subscription';
  tradingPlanId?: number;
  batchId?: string;
  dedupeKey?: string;
  start: number;
  overrides: ReturnType<typeof getOverridesFromBody>;
}) {
  const { autotrader, action, payload, webhookType, tradingPlanId, batchId, dedupeKey, start, overrides } = params;

  const exchange = await postgresDb.query.exchanges.findFirst({ where: eq(exchanges.id, autotrader.exchange_id) });
  if (!exchange) {
    log.error({ autotrader_id: autotrader.id }, 'Exchange configuration not found');
    return;
  }

  let webhookRowId: number | null = null;

  try {
    const insertedWebhook = await postgresDb.insert(webhooks).values({
      user_id: autotrader.user_id,
      exchange_id: autotrader.exchange_id,
      autotrader_id: autotrader.id,
      trading_plan_id: tradingPlanId ?? autotrader.trading_plan_id ?? null,
      batch_id: batchId ?? null,
      dedupe_key: dedupeKey ?? null,
      action,
      payload,
      status: 'pending',
      type: webhookType,
    }).onConflictDoNothing({ target: webhooks.dedupe_key }).returning({ id: webhooks.id });

    if (insertedWebhook.length === 0) {
      log.info({ dedupeKey, autotrader_id: autotrader.id }, 'Duplicate event skipped by dedupe key');
      return;
    }

    webhookRowId = insertedWebhook[0].id;

    const markWebhook = async (status: string, error_message?: string) => {
      if (!webhookRowId) return;
      await postgresDb.update(webhooks)
        .set({ status, error_message: error_message ?? null, processed_at: new Date() })
        .where(eq(webhooks.id, webhookRowId));
    };

    let credentials: Awaited<ReturnType<typeof resolveCredentials>>;
    try {
      credentials = await resolveCredentials(exchange.exchange_title, autotrader.exchange_id);
    } catch (err) {
      log.error({ err, autotrader_id: autotrader.id }, 'KMS decrypt failed');
      await markWebhook('failed', 'Failed to load exchange credentials');
      return;
    }

    let executor;
    try {
      executor = getExecutor(exchange.exchange_title);
    } catch (err) {
      await markWebhook('failed', (err as Error).message);
      return;
    }

    const execCtx = {
      autotrader,
      exchange,
      api_key: credentials.api_key,
      api_secret: credentials.api_secret,
      api_passphrase: (credentials as any).api_passphrase,
      exchange_user_id: credentials.exchange_user_id,
      action,
      overrides,
    };

    executor.execute(execCtx).then(async (result) => {
      if (!webhookRowId) return;
      if (!result.success) {
        exchangeErrorsTotal.inc({ exchange: exchange.exchange_title, component: 'executor' });
        tradesOpenedTotal.inc({ exchange: exchange.exchange_title, action, status: 'failed' });
        await Promise.all([
          markWebhook('failed', result.error),
          postgresDb.insert(webhook_responses).values({
            webhook_id: webhookRowId,
            user_id: autotrader.user_id,
            exchange_id: autotrader.exchange_id,
            response_status: 422,
            response_body: safeJson(result.raw),
            error_message: result.error ?? null,
          }),
        ]);
        return;
      }

      tradesOpenedTotal.inc({ exchange: exchange.exchange_title, action, status: 'success' });
      signalLatency.observe({ exchange: exchange.exchange_title, action }, Date.now() - start);
      await Promise.all([
        markWebhook('completed'),
        postgresDb.insert(webhook_responses).values({
          webhook_id: webhookRowId,
          user_id: autotrader.user_id,
          exchange_id: autotrader.exchange_id,
          response_status: 200,
          response_body: safeJson(result.raw),
        }),
      ]);
    }).catch(async (err) => {
      if (!webhookRowId) return;
      const errMsg = (err as Error).message ?? String(err);
      exchangeErrorsTotal.inc({ exchange: exchange.exchange_title, component: 'executor' });
      tradesOpenedTotal.inc({ exchange: exchange.exchange_title, action, status: 'failed' });
      await Promise.all([
        markWebhook('failed', errMsg),
        postgresDb.insert(webhook_responses).values({
          webhook_id: webhookRowId,
          user_id: autotrader.user_id,
          exchange_id: autotrader.exchange_id,
          response_status: 500,
          response_body: {},
          error_message: errMsg,
        }),
      ]);
    });
  } catch (err) {
    log.error({ err, autotrader_id: autotrader.id }, 'Failed to enqueue autotrader execution');
  }
}

export const SignalHandler = {
  handleSignal: async function (c: Context) {
    const start = Date.now();

    let body: z.infer<typeof signalSchema>;
    try {
      body = signalSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: 'Invalid payload', detail: (err as Error).message }, 400);
    }

    const autotrader = await postgresDb.query.autotraders.findFirst({
      where: eq(autotraders.webhook_token, body.token),
    });

    if (!autotrader) {
      return c.json({ error: 'Invalid token' }, 404);
    }

    if (autotrader.status !== 'active') {
      return c.json({ error: 'Autotrader is not active', status: autotrader.status }, 422);
    }

    await executeSignalForAutotrader({
      autotrader,
      action: body.action,
      payload: body as unknown as Record<string, unknown>,
      webhookType: 'personal',
      start,
      overrides: getOverridesFromBody(body),
    });

    const latency_ms = Date.now() - start;
    return c.json({
      ok: true,
      action: body.action,
      autotrader_id: autotrader.id,
      symbol: autotrader.symbol,
      latency_ms,
    });
  },

  handlePublicSignal: async function (c: Context) {
    const start = Date.now();

    let body: z.infer<typeof planSignalSchema>;
    try {
      body = planSignalSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: 'Invalid payload', detail: (err as Error).message }, 400);
    }

    const [keyRow] = await postgresDb
      .select()
      .from(trading_plan_keys)
      .where(and(eq(trading_plan_keys.id, body.key_id), eq(trading_plan_keys.is_active, true)))
      .limit(1);

    if (!keyRow) {
      return c.json({ error: 'Invalid key' }, 401);
    }

    const secretHash = sha256(body.secret);
    if (!safeEqualHex(keyRow.secret_hash, secretHash)) {
      return c.json({ error: 'Invalid key' }, 401);
    }

    const allowed = await checkRateLimit(keyRow.id, keyRow.rate_limit);
    if (!allowed) {
      return c.json({ error: 'Rate limit exceeded for this key' }, 429);
    }

    let followers = await postgresDb
      .select()
      .from(autotraders)
      .where(and(
        eq(autotraders.trading_plan_id, keyRow.trading_plan_id),
        eq(autotraders.status, 'active'),
      ));

    if (body.pair_id) {
      followers = followers.filter((f) => f.trading_plan_pair_id === body.pair_id);
    }

    if (body.pair_symbol) {
      const s = body.pair_symbol.toUpperCase();
      followers = followers.filter((f) => f.symbol.toUpperCase() === s || (f.pair ?? '').toUpperCase() === s);
    }

    const batchId = crypto.randomUUID();

    const dedupeKeyBase = body.event_id
      ? `plan:${keyRow.trading_plan_id}:event:${body.event_id}`
      : undefined;

    runBounded(
      followers,
      async (follower) => {
        await executeSignalForAutotrader({
          autotrader: follower,
          action: body.action,
          payload: body as unknown as Record<string, unknown>,
          webhookType: 'subscription',
          tradingPlanId: keyRow.trading_plan_id,
          batchId,
          dedupeKey: dedupeKeyBase ? `${dedupeKeyBase}:autotrader:${follower.id}` : undefined,
          start,
          overrides: getOverridesFromBody(body),
        });
      },
      10,
    ).catch((err) => {
      log.error({ err, batchId }, 'Plan signal fanout failed');
    });

    return c.json({
      ok: true,
      action: body.action,
      trading_plan_id: keyRow.trading_plan_id,
      followers_count: followers.length,
      batch_id: batchId,
      dedupe_event_id: body.event_id ?? null,
      latency_ms: Date.now() - start,
    });
  },
};
