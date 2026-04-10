import { Hono } from 'hono'
import { cors } from 'hono/cors'
import gateRouter from './routes/gateRoutes'
import sseRouter from './routes/sseRoutes'
import userRouter from './routes/userRoutes'
import { client, closeConnection, testConnection } from './db/client'
import redis from './db/redis'
import okxRouter from './routes/okxRoutes'
import autotraderRouter from './routes/autotraderRoutes'
import tradingPlanRouter from './routes/tradingPlanRoutes'
import hyperliquidRouter from './routes/hyperliquidRoutes'
import tokocryptoRouter from './routes/tokocryptoRoutes'
import webhookRouter from './routes/webhookRoutes'
import bitgetRouter from './routes/bitgetRoutes'
import mexcRouter from './routes/mexcRoutes'
import bitmartRouter from './routes/bitmartRoutes'
import metricsRouter from './routes/metricsRoute'
import { pinoLoggerMiddleware } from './middleware/pinoLogger'
import { logger, flushLogger } from './utils/logger'

const log = logger.child({ process: 'api' })

const app = new Hono()
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  process.env.CORS_ORIGIN,
]

app.use('*', cors({
  origin: (origin) => {
    return allowedOrigins.includes(origin) ? origin : allowedOrigins[0]
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}))
app.use('*', async (c, next) => {
  if (c.req.path === '/health' || c.req.path === '/health-async') {
    await next()
  } else {
    await pinoLoggerMiddleware(c, next)
  }
})
app.get('/', (c) => {
  return c.text('Hello Hono!')
})
app.route('/gate', gateRouter)
app.route('/okx', okxRouter)
app.route('/hyperliquid', hyperliquidRouter)
app.route('/tokocrypto', tokocryptoRouter)
app.route('/bitget', bitgetRouter)
app.route('/mexc', mexcRouter)
app.route('/bitmart', bitmartRouter)

app.route('/webhook', webhookRouter)
app.route('/sse', sseRouter)
app.route('/user', userRouter)
app.route('/autotraders', autotraderRouter)
app.route('/trading-plans', tradingPlanRouter)
app.route('/metrics', metricsRouter)


// Health check endpoint
app.get('/health', async (c) => {
  const start = performance.now();

  await client`SELECT 1`;
  const dbEnd = performance.now();

  await redis.ping();
  const redisEnd = performance.now();

  return c.json({
    status: 'healthy',
    metrics: {
      db_ms: (dbEnd - start).toFixed(2),
      redis_ms: (redisEnd - dbEnd).toFixed(2),
      total_ms: (performance.now() - start).toFixed(2)
    }
  });
});

app.get('/health-async', async (c) => {
  const start = performance.now();

  try {
    await Promise.all([
      client`SELECT 1`,
      redis.ping()
    ]);

    const total_ms = (performance.now() - start).toFixed(2);

    return c.json({
      status: 'healthy',
      metrics: { total_ms, note: "Parallel check executed" }
    });
  } catch (error: Error | any) {
    return c.json({ status: 'unhealthy', error: (error as Error).message }, 503);
  }
});

const port = parseInt(process.env['PORT'] || '1122')

async function initializeConnections() {
  log.info('Initializing database connections');

  try {
    const postgresOk = await testConnection();
    if (!postgresOk) {
      log.error('PostgreSQL connection failed — application may not work correctly');
    }
    log.info('Connections initialized');
  } catch (err) {
    log.error({ err }, 'Failed to initialize connections');
  }
}

async function gracefulShutdown(signal: string) {
  log.info({ signal }, 'Shutting down gracefully');

  try {
    log.info('Closing Redis connection');
    await redis.quit();

    await closeConnection();
    await flushLogger();

    log.info('All connections closed cleanly');
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception');
});

process.on('unhandledRejection', (reason, promise) => {
  log.error({ reason, promise: String(promise) }, 'Unhandled rejection');
});

async function startApp() {
  await initializeConnections();

  log.info({ port }, 'Server starting');

  Bun.serve({
    hostname: "0.0.0.0",
    port,
    fetch: app.fetch,
    idleTimeout: 0,
  });
}

startApp().catch((err) => {
  log.fatal({ err }, 'Failed to start application');
  process.exit(1);
});
