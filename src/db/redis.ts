import Redis from "ioredis";

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
  console.log('✅ Redis connected successfully');
});

redis.on('error', (err) => {
  console.error('❌ Redis connection error:', err);
});

redis.on('close', () => {
  console.log('🔌 Redis connection closed');
});

// Test connection on startup
redis.ping()
  .then(() => console.log('✅ Redis ping successful'))
  .catch(err => console.error('❌ Redis ping failed:', err));

export default redis;
