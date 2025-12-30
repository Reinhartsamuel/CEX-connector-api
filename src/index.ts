import { Hono } from 'hono'
import gateRouter from './routes/gateRoutes'
import sseRouter from './routes/sseRoutes'
import { logger } from 'hono/logger'
import { client, closeConnection, testConnection } from './db/client'
import redis from './db/redis'
import okxRouter from './routes/okxRoutes'

const app = new Hono()
app.use('*', async (c, next) => {
  // If the path is /health, just skip the logger and go to the next middleware
  if (c.req.path === '/health' || c.req.path === '/health-async') {
    await next()
  } else {
    // Otherwise, use the standard Hono logger
    await logger()(c, next)
  }
})
app.get('/', (c) => {
  return c.text('Hello Hono!')
})
app.route('/gate', gateRouter)
app.route('/okx', okxRouter)
app.route('/sse', sseRouter)



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
    // Run both pings simultaneously
    const [dbResult, redisResult] = await Promise.all([
      client`SELECT 1`,
      redis.ping()
    ]);

    const total_ms = (performance.now() - start).toFixed(2);

    return c.json({
      status: 'healthy',
      metrics: {
        total_ms, // This should drop to ~245ms now
        note: "Parallel check executed"
      }
    });
  } catch (error:Error|any) {
    return c.json({ status: 'unhealthy', error: (error as Error).message }, 503);
  }
});

const port = parseInt(process.env['PORT'] || '1122')
// const port = parseInt(process.env.PORT!)
// console.log(`Server starting on port ${port}`)
// Initialize connections on startup
async function initializeConnections() {
  console.log('🚀 Initializing database connections...');

  try {
    // Test PostgreSQL connection
    const postgresOk = await testConnection();
    if (!postgresOk) {
      console.error('❌ PostgreSQL connection failed. Application may not work correctly.');
    }

    // Note: Redis connection test happens in redis.ts on import
    console.log('✅ Connections initialized');
  } catch (error) {
    console.error('❌ Failed to initialize connections:', error);
  }
}

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received, shutting down gracefully...`);

  try {
    // Close Redis connection
    console.log('🔌 Closing Redis connection...');
    await redis.quit();

    // Close PostgreSQL connections
    await closeConnection();

    console.log('✅ All connections closed cleanly');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
}

// Set up signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the application
async function startApp() {
  await initializeConnections();

  console.log(`🚀 Server starting on port ${port}`);

  Bun.serve({
    hostname: "0.0.0.0",
    port,
    fetch: app.fetch,
  });
}

startApp().catch(error => {
  console.error('💥 Failed to start application:', error);
  process.exit(1);
});

// Bun.serve({
//   port,
//   fetch: app.fetch,
// })
