# Test Setup for Byscript Connector API

This document describes how to test the new Redis-controlled WebSocket worker architecture.

## Prerequisites

1. Redis server running locally
2. Bun runtime installed

## Quick Setup

### 1. Start Redis
```bash
docker run -p 6379:6379 redis
```

### 2. Test the Hono API
```bash
# Terminal 1: Start the Hono API
bun run src/index.ts
```

### 3. Test the Gate Worker
```bash
# Terminal 2: Start the Gate Worker
bun run src/workers/gateWorkerRunner.ts
```

## Test Endpoints

### Place Futures Order (triggers WebSocket connection)
```bash
curl -X POST http://localhost:1122/gate/place-futures-order \
  -H "Content-Type: application/json" \
  -H "api-key: YOUR_GATE_API_KEY" \
  -H "api-secret: YOUR_GATE_API_SECRET" \
  -d '{
    "userId": "test_user_123",
    "market_type": "market",
    "price": 0.0,
    "contract": "BTC_USDT",
    "leverage": 10,
    "leverage_type": "ISOLATED",
    "size": 1,
    "position_type": "long",
    "take_profit": {
      "enabled": false,
      "price": "0",
      "price_type": "mark"
    },
    "stop_loss": {
      "enabled": false,
      "price": "0",
      "price_type": "mark"
    },
    "reduce_only": false
  }'
```

### Verify Redis Storage
```bash
# Check stored credentials
redis-cli HGETALL gate:creds:test_user_123

# Check stored orders
redis-cli HGETALL user:test_user_123:orders
```

### Test SSE Endpoint
```bash
# Terminal 3: Listen for real-time order updates
curl -N http://localhost:1122/sse/sse/orders/test_user_123
```

## Expected Behavior

1. **Hono API**: Should start on port 1122 and accept requests
2. **Worker**: Should log "Worker: subscribing to control channel ws-control"
3. **Order Placement**: 
   - Places order via Gate API
   - Stores credentials in Redis (`gate:creds:{userId}`)
   - Publishes control message to `ws-control` channel
4. **Worker Response**:
   - Receives control message
   - Opens WebSocket connection for the user
   - Subscribes to futures.orders channel
   - Stores order updates in Redis (`user:{userId}:orders`)
   - Publishes real-time events to `user:{userId}:orders:chan`

## PM2 Deployment

```bash
# Start both services with PM2
pm2 start ecosystem.config.js

# Scale gate-worker instances
pm2 scale gate-worker 4

# Monitor services
pm2 status
pm2 logs
```

## Troubleshooting

### Common Issues

1. **Redis Connection**: Ensure Redis is running on `redis://127.0.0.1:6379`
2. **Worker Not Starting**: Check Redis URL environment variable
3. **WebSocket Connection**: Verify Gate API credentials are valid
4. **SSE Not Working**: Check Redis pub/sub channels

### Debug Commands

```bash
# Monitor Redis pub/sub
redis-cli monitor

# Check PM2 logs
pm2 logs hono-api
pm2 logs gate-worker

# Test Redis connectivity
redis-cli PING
```

## Environment Variables

- `REDIS_URL`: Redis connection string (default: `redis://127.0.0.1:6379`)
- `PORT`: Hono API port (default: `1122`)
- `GATE_API_KEY`: Gate.io API key (for testing old worker)
- `GATE_API_SECRET`: Gate.io API secret (for testing old worker)

## Architecture Overview

- **Hono API**: Handles HTTP requests, stores credentials, publishes control messages
- **Gate Worker**: Subscribes to control channel, manages per-user WebSocket connections
- **Redis**: Central message bus for control and real-time data
- **SSE**: Provides real-time order updates to frontend clients