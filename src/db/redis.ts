import Redis from "ioredis";
import { createLogger } from '../utils/logger';

const log = createLogger({ process: 'api', component: 'redis' });

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

// Create Redis client with connection pooling
export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

// Connection event handlers
redis.on('connect', () => {
  log.info('Redis connected successfully');
});

redis.on('error', (err) => {
  log.error({ err }, 'Redis connection error');
});

redis.on('close', () => {
  log.info('Redis connection closed');
});

// Test connection on startup
redis.ping()
  .then(() => log.info('Redis ping successful'))
  .catch(err => log.error({ err }, 'Redis ping failed'));

export default redis;


