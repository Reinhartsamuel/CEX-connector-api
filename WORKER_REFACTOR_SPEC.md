# Worker Architecture Refactor Spec
## Single WorkerManager with Pluggable Exchange Adapters

**Goal:** Replace 4 (by this time this number may already be higher) separate worker processes with one unified `WorkerManager` process that
hosts all exchange adapters. Modeled after how 3Commas and Pionex handle multi-exchange
connectivity: shared infrastructure, isolated adapter logic, production-grade reliability.

---

## 1. Why

| Current | Target |
|---------|--------|
| 4 separate Node processes | 1 process, N adapters |
| 4× Redis connections (×2 each = 8 total) | 1 shared Redis pool |
| 4× DB connection pools | 1 shared DB pool |
| Bug fixed in Gate must be fixed in 3 other workers manually | Fix once in BaseAdapter |
| No health endpoint | HTTP health endpoint per adapter + aggregate |
| No structured logging | pino with correlation IDs |
| No graceful shutdown | SIGTERM drains in-flight writes, then exits |
| No DLQ for failed DB writes | Redis-backed DLQ with retry |

---

## 2. Target Architecture

```
WorkerManager (src/workers/index.ts)
  ├── SharedInfra
  │     ├── Redis pool (ioredis Cluster or single)
  │     ├── Postgres pool (postgresDb)
  │     ├── Logger (pino)
  │     └── HTTP health server (:9000)
  │
  ├── ControlRouter
  │     └── Subscribes to ws-control, routes cmd.exchange → adapter
  │
  ├── DLQWorker
  │     └── Drains dlq:{exchange} Redis lists, retries failed DB writes
  │
  └── Adapters (one instance per registered exchange)
        ├── GateAdapter       extends BaseAdapter
        ├── OKXAdapter        extends BaseAdapter
        ├── HyperliquidAdapter extends BaseAdapter
        └── TokocryptoAdapter extends BaseAdapter
```

---

## 3. BaseAdapter Interface

File: `src/workers/base/BaseAdapter.ts`

```typescript
export interface AdapterConfig {
  exchangeTitle: string      // matches exchanges.exchange_title in DB
  logger: pino.Logger
  redis: Redis
  db: typeof postgresDb
}

export abstract class BaseAdapter {
  abstract readonly exchangeTitle: string

  // Lifecycle
  abstract ensureConnection(userId: string, extra?: Record<string, string>): Promise<void>
  abstract closeConnection(userId: string): void

  // Called by WorkerManager on ws-control message
  abstract handleControlCommand(cmd: ControlCommand): void

  // Called on startup to reconnect users with active trades
  abstract restoreConnections(): Promise<void>

  // Called by DLQWorker to replay a failed event
  abstract replayEvent(event: DLQEvent): Promise<void>

  // Expose health data
  abstract getHealth(): AdapterHealth
}

export interface AdapterHealth {
  exchange: string
  connections: number
  uptime_ms: number
  last_event_at: number | null
  errors_last_5m: number
}
```

---

## 4. Shared Connection State

File: `src/workers/base/ConnectionState.ts`

```typescript
export interface ConnectionState {
  ws: WebSocket | null
  pingInterval?: NodeJS.Timeout
  reconnectTimer?: NodeJS.Timeout
  backoff: number
  intentionalClose: boolean    // fixes reconnect-after-closeConnection bug
  lastEventAt: number | null
  errorCount: number
  // exchange-specific extras stored here
  extra: Record<string, any>
}
```

**Key field:** `intentionalClose` — set to `true` before calling `ws.close()` in
`closeConnection()`. `onWsClose` checks this and skips reconnect if true. Fixes the
current bug where all workers reconnect even after intentional close.

---

## 5. ControlRouter

File: `src/workers/ControlRouter.ts`

- Subscribes to `ws-control` Redis channel (one subscription, shared)
- Routes by `cmd.exchange` field:
  - `"gate"` → GateAdapter
  - `"okx"` → OKXAdapter
  - `"hyperliquid"` → HyperliquidAdapter
  - `"tokocrypto"` → TokocryptoAdapter
  - missing/unknown → warn log, discard
- Commands: `open`, `close`
- Gate/Tokocrypto/OKX currently don't send `cmd.exchange` in the executor publish —
  **executors must be updated** to include `exchange` field in the Redis publish payload.

### Executor changes needed

In each executor's `openPosition`:
```typescript
await redis.publish('ws-control', JSON.stringify({
  op: 'open',
  exchange: 'gate',         // ADD THIS
  userId: String(exchange_user_id),
  contract,
}));
```

---

## 6. DLQ (Dead Letter Queue)

File: `src/workers/DLQWorker.ts`

### Write path (in every adapter's event handler)

When a DB write fails, instead of logging and losing the event:
```typescript
try {
  await db.update(trades).set(...).where(...)
} catch (err) {
  logger.error({ err, event }, 'DB write failed — pushing to DLQ')
  await redis.lpush(`dlq:${this.exchangeTitle}`, JSON.stringify({
    id: crypto.randomUUID(),
    exchange: this.exchangeTitle,
    userId,
    event,           // the raw WS message or reconcile data
    handler,         // 'order_filled_open' | 'position_closed' | etc.
    failedAt: Date.now(),
    attempts: 0,
  }))
}
```

### Retry path (DLQWorker)

- Runs on an interval (every 30s)
- `RPOPLPUSH dlq:{exchange} dlq:{exchange}:processing`
- Calls `adapter.replayEvent(event)`
- On success: remove from processing list
- On failure after 5 attempts: move to `dlq:{exchange}:dead`, alert via log (future: Slack/email)
- Max DLQ size: 10,000 events per exchange (configurable)

---

## 7. Graceful Shutdown

File: `src/workers/index.ts`

```typescript
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutdown initiated')

  // 1. Stop accepting new WS control commands
  controlRouter.stop()

  // 2. Close all WS connections (intentional)
  for (const adapter of adapters) {
    adapter.closeAllConnections()
  }

  // 3. Wait for in-flight DB transactions (max 10s)
  await Promise.race([
    waitForInflight(),
    sleep(10_000),
  ])

  // 4. Flush DLQ retry
  await dlqWorker.flush()

  // 5. Close Redis and DB
  await redis.quit()
  await db.end?.()

  logger.info('Shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
```

---

## 8. Health HTTP Server

File: `src/workers/HealthServer.ts`

Binds to `:9000` (configurable via `WORKER_HEALTH_PORT` env).

### Endpoints

**`GET /health`** — aggregate
```json
{
  "status": "ok",
  "uptime_ms": 123456,
  "adapters": [
    {
      "exchange": "gate",
      "connections": 12,
      "last_event_at": 1710000000000,
      "errors_last_5m": 0
    }
  ],
  "dlq": {
    "gate": 0,
    "okx": 2
  }
}
```

**`GET /health/:exchange`** — per-adapter detail

**`GET /metrics`** — Prometheus-compatible text format (for future Grafana integration)
```
worker_connections{exchange="gate"} 12
worker_errors_total{exchange="gate"} 0
worker_dlq_size{exchange="gate"} 0
```

---

## 9. Structured Logging

Replace all `console.log` / `console.error` with pino.

### Log schema

Every log line must include:
```typescript
{
  time,            // ISO timestamp
  level,           // info | warn | error
  exchange,        // 'gate' | 'okx' | 'hyperliquid' | 'tokocrypto'
  userId,          // exchange_user_id
  tradeId?,        // trade_id when applicable
  orderId?,        // order id when applicable
  event?,          // WS event type
  latency_ms?,     // for reconcile/REST calls
  msg              // human-readable message
}
```

### Log levels
- `debug` — raw WS messages (disabled in production via `LOG_LEVEL=info`)
- `info` — connection open/close, order events processed, reconcile complete
- `warn` — missing trade in DB, order not found in REST, DLQ push
- `error` — DB write failure, WS parse error, REST error

---

## 10. Reconciliation Cron (Periodic, not just on WS connect)

Currently reconciliation only runs once after WS connects. Add a periodic loop.

File: `src/workers/ReconcileCron.ts`

- Interval: every 60 seconds (configurable via `RECONCILE_INTERVAL_MS` env)
- For each adapter, call `adapter.reconcileAll()`:
  - Query all `waiting_position` / `partially_filled` / `waiting_targets` trades for that exchange
  - Cross-check against exchange REST API
  - Apply corrections in a single DB transaction
- Skip if reconcile already running for that adapter (mutex per adapter)
- Log reconcile duration and number of corrections made

---

## 11. PM2 Config (interim, before full refactor)

File: `ecosystem.config.js` (repo root)

```js
module.exports = {
  apps: [
    {
      name: 'worker-gate',
      script: './src/workers/gateWorkerRunner.ts',
      interpreter: 'bun',
      watch: false,
      max_memory_restart: '512M',
      exp_backoff_restart_delay: 100,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'worker-okx',
      script: './src/workers/okxWorkerRunner.ts',
      interpreter: 'bun',
      watch: false,
      max_memory_restart: '512M',
      exp_backoff_restart_delay: 100,
    },
    {
      name: 'worker-hyperliquid',
      script: './src/workers/hyperliquidWorkerRunner.ts',
      interpreter: 'bun',
      watch: false,
      max_memory_restart: '512M',
      exp_backoff_restart_delay: 100,
    },
    {
      name: 'worker-tokocrypto',
      script: './src/workers/tokocryptoWorkerRunner.ts',
      interpreter: 'bun',
      watch: false,
      max_memory_restart: '512M',
      exp_backoff_restart_delay: 100,
    },
  ],
}
```

---

## 12. Task Checklist

### Phase 0 — Immediate (do before beta)
- [ ] Add `ecosystem.config.js` with PM2 config for all 4 current workers
- [ ] Add `WORKER_HEALTH_PORT` env support and basic `/health` endpoint to each existing worker
- [ ] Fix intentional close bug: add `intentionalClose` flag to all 4 workers' connection state
- [ ] Add `cmd.exchange` to all executor Redis publishes (gate, okx, hyperliquid, tokocrypto executors)

### Phase 1 — BaseAdapter extraction
- [ ] Create `src/workers/base/BaseAdapter.ts` with abstract class
- [ ] Create `src/workers/base/ConnectionState.ts` with shared interface
- [ ] Extract shared logic from GateAdapter into BaseAdapter:
  - [ ] `restoreConnections()` (same pattern in all 4)
  - [ ] `scheduleReconnect()` with exponential backoff
  - [ ] `onWsClose()` with intentional close check
  - [ ] `pingInterval` management
  - [ ] DLQ push on DB write failure
- [ ] Implement `GateAdapter extends BaseAdapter`
- [ ] Implement `OKXAdapter extends BaseAdapter`
- [ ] Implement `HyperliquidAdapter extends BaseAdapter`
- [ ] Implement `TokocryptoAdapter extends BaseAdapter`

### Phase 2 — WorkerManager
- [ ] Create `src/workers/index.ts` as the single entry point
- [ ] Implement `ControlRouter` (single Redis sub, routes to adapters)
- [ ] Implement `DLQWorker` with retry loop
- [ ] Implement `ReconcileCron` (60s periodic reconcile for all adapters)
- [ ] Implement `HealthServer` at `:9000`
- [ ] Implement graceful shutdown (SIGTERM/SIGINT handler)
- [ ] Update `ecosystem.config.js` to run single `worker` process instead of 4

### Phase 3 — Observability
- [ ] Install pino (`bun add pino pino-pretty`)
- [ ] Replace all `console.log/warn/error` in workers with pino logger
- [ ] Add `exchange`, `userId`, `tradeId` to every log line
- [ ] Add `GET /metrics` Prometheus endpoint
- [ ] (Optional) Set up Grafana dashboard with:
  - Active connections per exchange
  - Events processed per minute
  - DLQ size
  - Error rate

### Phase 4 — Hardening
- [ ] Add `MAX_CONNECTIONS_PER_EXCHANGE` limit (prevent memory exhaustion)
- [ ] Add per-user rate limiting on WS event processing (token bucket)
- [ ] Add circuit breaker per exchange REST client (stop hammering if exchange is down)
- [ ] Write integration tests for each adapter's happy path:
  - market order open → waiting_targets with fill price
  - limit order open → waiting_position → waiting_targets on fill
  - position closed → closed with PnL
  - worker restart → connections restored → reconcile catches missed events

---

## 13. File Structure (Target)

```
src/workers/
  index.ts                    # WorkerManager entry point
  ControlRouter.ts            # Routes ws-control to adapters
  DLQWorker.ts                # Retry failed DB writes
  ReconcileCron.ts            # Periodic reconcile loop
  HealthServer.ts             # HTTP :9000
  base/
    BaseAdapter.ts            # Abstract class
    ConnectionState.ts        # Shared connection interface
    types.ts                  # ControlCommand, DLQEvent, AdapterHealth
  adapters/
    GateAdapter.ts
    OKXAdapter.ts
    HyperliquidAdapter.ts
    TokocryptoAdapter.ts
  # Legacy (delete after Phase 2)
  gateWorkerRunner.ts
  okxWorkerRunner.ts
  hyperliquidWorkerRunner.ts
  tokocryptoWorkerRunner.ts
```

---

## 14. Environment Variables (new)

```env
WORKER_HEALTH_PORT=9000
RECONCILE_INTERVAL_MS=60000
DLQ_RETRY_INTERVAL_MS=30000
DLQ_MAX_ATTEMPTS=5
MAX_CONNECTIONS_PER_EXCHANGE=500
LOG_LEVEL=info
```

---

## 15. Definition of Done

The refactor is complete when:
- [ ] Single `bun src/workers/index.ts` starts all exchange adapters
- [ ] `GET /health` returns live connection counts for all exchanges
- [ ] Worker restart reconnects all users with active trades within 10 seconds
- [ ] A simulated DB failure pushes to DLQ and retries successfully within 60 seconds
- [ ] A simulated WS disconnect triggers reconnect with backoff, not for intentional close
- [ ] All logs are structured JSON with exchange/userId/tradeId fields
- [ ] PM2 `ecosystem.config.js` runs the single worker with auto-restart
