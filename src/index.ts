import { Hono } from 'hono'
import gateRouter from './routes/gateRoutes'
import sseRouter from './routes/sseRoutes'
import { logger } from 'hono/logger'
import { client, closeConnection, testConnection } from './db/client'
import redis from './db/redis'

const app = new Hono()
app.use(logger())
app.get('/', (c) => {
  return c.text('Hello Hono!')
})
app.route('/gate', gateRouter)
app.route('/sse', sseRouter)




// Health check endpoint
app.get('/health', async (c) => {
  try {
    // Check PostgreSQL
    await client`SELECT 1`;

    // Check Redis
    await redis.ping();

    return c.json({
      status: 'healthy',
      postgres: 'connected',
      redis: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Health check failed:', error);
    return c.json({
      status: 'unhealthy',
      postgres: 'error',
      redis: 'error',
      error: error.message
    }, 503);
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
