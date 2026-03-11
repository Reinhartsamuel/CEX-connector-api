# High Availability Spec
## Zero Message Loss for Trading Workers

**Goal:** Ensure no trade event, DB write, or signal is ever silently lost due to worker
crashes, Redis downtime, or DB failures. Achieve this with minimal new infrastructure —
no new services beyond replacing self-hosted Redis with a managed replicated instance.

---

## 1. Why the Current Stack is Fragile

| Component | Current failure mode | Impact |
|---|---|---|
| Redis pub/sub (`ws-control`) | Message dropped if worker is down at publish time | Signal arrives, order placed, WS never opens — trade stuck |
| DB writes in workers | `catch (err) { console.error }` — error swallowed | Trade state wrong forever, no retry |
| Single-node Railway Redis | Container restart wipes all data | Position cache gone, cred cache gone, pub/sub dead |
| Reconcile only on WS connect | Missed events between crash and reconnect never corrected | Stale trade states survive indefinitely |
| Worker crashes mid-trade | In-flight WS event lost | Position closed on exchange, DB still shows `waiting_targets` |

---

## 2. Target Reliability Properties

- **At-least-once delivery** for all `ws-control` commands (open/close)
- **No silent DB write failures** — every failed write goes to DLQ and retries
- **Periodic truth reconciliation** — DB corrected against exchange REST every 60s
- **Redis failure tolerance** — replicated Redis survives node restarts
- **Idempotent DB writes** — replaying a message never creates duplicate trades

---

## 3. Redis: Replace Self-Hosted with Managed Replicated Instance

### Problem
Railway Redis = single container. Restart (deploy, OOM, maintenance) → 10–30s outage.
During that window: pub/sub dead, caches wiped, workers can't reconnect users.

### Solution
Replace `REDIS_URL` with Upstash Redis (or Redis Cloud free tier).

**Upstash advantages:**
- Replication built in — survives node restarts
- RDB persistence — data survives full outage
- Free tier (10k commands/day) sufficient for early stage
- REST API fallback if TCP blocked
- No Railway service to manage

### Migration
1. Create Upstash account → new Redis database → copy `REDIS_URL`
2. Set `REDIS_URL` in Railway environment variables
3. Delete Railway Redis service
4. No code changes required

### What to persist (set TTL appropriately)
| Key pattern | TTL | Notes |
|---|---|---|
| `gate:creds:{userId}` | None | Permanent until exchange disconnected |
| `user:{userId}:positions` | None | Updated on every position event |
| `ws:ready:gate:{userId}` | 30s | Short-lived ready signal |
| `dlq:{exchange}` | None | Must survive restarts |

---

## 4. ws-control: Redis Pub/Sub → Redis Streams

### Problem
`redis.publish('ws-control', ...)` is fire-and-forget. If worker is down or hasn't
subscribed yet, the message is gone. No retry, no persistence, no acknowledgement.

### Solution
Replace pub/sub with **Redis Streams** (`XADD` / `XREADGROUP`).

### How it works
```
Executor (producer):
  XADD ws-control-stream * op open exchange gate userId 123 contract BTC_USDT

Worker (consumer group, one group per exchange):
  XREADGROUP GROUP gate-workers worker-1 COUNT 10 BLOCK 5000 STREAMS ws-control-stream >
  ... process message ...
  XACK ws-control-stream gate-workers <message-id>
```

- Message persists in stream until ACKed
- If worker crashes before ACK: message stays "pending", redelivered on restart via `XAUTOCLAIM`
- Multiple workers can consume from the same stream (each gets its own messages via consumer groups)
- Stream can be trimmed to last N messages: `XADD ... MAXLEN ~ 10000`

### Stream key structure
```
ws-control-stream         # single stream, all exchanges
```

Each message includes `exchange` field so workers filter for their own:
```typescript
// Worker only processes messages for its exchange
if (msg.exchange !== this.exchangeTitle) {
  await redis.xack('ws-control-stream', 'all-workers', id)
  continue
}
```

Or use **per-exchange streams** for cleaner separation:
```
ws-control:gate
ws-control:okx
ws-control:hyperliquid
ws-control:tokocrypto
```

### Pending message redelivery
```typescript
// On worker startup, reclaim messages pending > 30s (from crashed worker)
const pending = await redis.xautoclaim(
  'ws-control:gate',
  'gate-workers',
  'worker-1',
  30_000,   // min idle time ms
  '0-0',    // start from beginning
)
```

### Executor changes
Replace `redis.publish` with `redis.xadd`:
```typescript
// Before
await redis.publish('ws-control', JSON.stringify({ op: 'open', exchange: 'gate', userId, contract }))

// After
await redis.xadd('ws-control:gate', '*',
  'op', 'open',
  'userId', String(userId),
  'contract', contract,
)
```

---

## 5. DLQ: Dead Letter Queue for DB Write Failures

### Problem
Every worker has DB writes inside WS event handlers. Current pattern:
```typescript
try {
  await db.update(trades).set(...).where(...)
} catch (err) {
  console.error('DB write failed', err)  // event lost forever
}
```

### Solution
On DB write failure, push to a Redis List (`dlq:{exchange}`). A DLQWorker drains and
retries every 30 seconds.

### Write path (in every adapter's WS handler)
```typescript
try {
  await db.update(trades).set({ status: 'waiting_targets', ... }).where(...)
} catch (err) {
  logger.error({ err, event }, 'DB write failed — pushing to DLQ')
  await redis.lpush(`dlq:gate`, JSON.stringify({
    id: crypto.randomUUID(),
    exchange: 'gate',
    userId,
    tradeId,
    handler: 'order_filled_open',   // which handler failed
    event,                           // raw WS message
    failedAt: Date.now(),
    attempts: 0,
  }))
}
```

### DLQWorker retry loop (runs every 30s)
```typescript
async function drainDLQ(exchange: string) {
  while (true) {
    // Atomically move item to processing list
    const raw = await redis.rpoplpush(`dlq:${exchange}`, `dlq:${exchange}:processing`)
    if (!raw) break

    const item = JSON.parse(raw)

    if (item.attempts >= 5) {
      // Move to dead list, alert
      await redis.lpush(`dlq:${exchange}:dead`, raw)
      logger.error({ item }, 'DLQ item exceeded max attempts — moved to dead list')
      await redis.lrem(`dlq:${exchange}:processing`, 1, raw)
      continue
    }

    try {
      await replayEvent(item)   // re-run the DB write
      await redis.lrem(`dlq:${exchange}:processing`, 1, raw)
      logger.info({ item }, 'DLQ item replayed successfully')
    } catch (err) {
      item.attempts++
      item.lastAttemptAt = Date.now()
      await redis.lrem(`dlq:${exchange}:processing`, 1, raw)
      await redis.lpush(`dlq:${exchange}`, JSON.stringify(item))
      logger.warn({ err, item }, 'DLQ retry failed, requeueing')
    }
  }
}
```

### replayEvent dispatch
Each handler type maps to a specific DB write function:
```typescript
async function replayEvent(item: DLQItem) {
  switch (item.handler) {
    case 'order_filled_open':
      await db.update(trades).set({ status: 'waiting_targets', ... }).where(eq(trades.trade_id, item.tradeId))
      break
    case 'position_closed':
      await db.update(trades).set({ status: 'closed', pnl: item.event.pnl, ... }).where(...)
      break
    // ... etc
  }
}
```

### DLQ monitoring
- Check `dlq:{exchange}` list length in health endpoint
- Alert if `dlq:{exchange}:dead` has any items (means 5 retries failed — needs manual inspection)
- Max DLQ size: 10,000 items per exchange (trim oldest if exceeded)

---

## 6. ReconcileCron: Periodic REST Cross-Check

### Problem
WS is unreliable. Any event missed between crash and reconnect leaves DB state stale
indefinitely. `restoreConnections()` only runs on startup — doesn't help for events
missed while the worker was running but WS was briefly disconnected.

### Solution
Every 60 seconds, for each exchange, query the REST API for all active trades and compare
against DB. Apply corrections atomically.

### What it reconciles

**For Gate (and OKX/Tokocrypto similarly):**

1. **`waiting_position` trades** — check if order filled or cancelled
   - Query `GET /futures/usdt/orders/{order_id}`
   - If `finish_as === 'filled'`: update DB to `waiting_targets`, write `open_fill_price`
   - If `finish_as === 'cancelled'`: update DB to `cancelled`

2. **`waiting_targets` trades** — check if position still open
   - Query `GET /futures/usdt/positions/{contract}`
   - If position size = 0: update DB to `closed`, write PnL from settlement history

3. **`partially_filled` trades** — same as waiting_position

### Implementation

```typescript
// ReconcileCron.ts
const reconcileMutex = new Map<string, boolean>()

async function reconcileExchange(exchange: string, adapter: BaseAdapter) {
  if (reconcileMutex.get(exchange)) {
    logger.warn({ exchange }, 'Reconcile already running, skipping')
    return
  }
  reconcileMutex.set(exchange, true)

  const startedAt = Date.now()
  let corrections = 0

  try {
    const activeTrades = await db
      .select()
      .from(trades)
      .innerJoin(exchanges, eq(trades.exchange_id, exchanges.id))
      .where(and(
        eq(exchanges.exchange_title, exchange),
        inArray(trades.status, ['waiting_position', 'partially_filled', 'waiting_targets'])
      ))

    corrections = await adapter.reconcileAll(activeTrades)

    logger.info({ exchange, corrections, latency_ms: Date.now() - startedAt }, 'Reconcile complete')
  } catch (err) {
    logger.error({ exchange, err }, 'Reconcile failed')
  } finally {
    reconcileMutex.delete(exchange)
  }
}

// Run every 60s for all exchanges
setInterval(() => {
  for (const [exchange, adapter] of adapters) {
    reconcileExchange(exchange, adapter)
  }
}, Number(process.env.RECONCILE_INTERVAL_MS) || 60_000)
```

### Gate reconcileAll example
```typescript
async reconcileAll(activeTrades: Trade[]) {
  let corrections = 0

  // Phase 1: Fetch REST data outside transaction
  const updates: Array<{ id: number; set: Partial<Trade> }> = []

  for (const trade of activeTrades) {
    if (trade.status === 'waiting_position' || trade.status === 'partially_filled') {
      const order = await GateServices.getOrder(trade.order_id)
      if (order.finish_as === 'filled') {
        updates.push({ id: trade.id, set: {
          status: 'waiting_targets',
          open_fill_price: order.fill_price,
          open_filled_at: Number(order.finish_time),
        }})
      } else if (order.finish_as === 'cancelled') {
        updates.push({ id: trade.id, set: { status: 'cancelled' }})
      }
    }

    if (trade.status === 'waiting_targets') {
      const position = await GateServices.getPosition(trade.contract)
      if (parseFloat(position.size) === 0) {
        const settlement = await GateServices.getSettlement(trade.trade_id)
        updates.push({ id: trade.id, set: {
          status: 'closed',
          pnl: settlement.pnl,
          closed_at: new Date(),
        }})
      }
    }
  }

  // Phase 2: Batch update in single transaction
  if (updates.length > 0) {
    await db.transaction(async (tx) => {
      for (const { id, set } of updates) {
        await tx.update(trades).set(set).where(eq(trades.id, id))
        corrections++
      }
    })
  }

  return corrections
}
```

---

## 7. Idempotent DB Writes

### Problem
Replaying a DLQ event or running reconcile twice could insert duplicate trade records.

### Solution
Use `onConflictDoUpdate` for inserts and guard updates with status checks.

```typescript
// Insert: idempotent on trade_id
await db.insert(trades).values({ trade_id: '123', status: 'waiting_position', ... })
  .onConflictDoUpdate({
    target: trades.trade_id,
    set: {
      status: sql`EXCLUDED.status`,
      open_fill_price: sql`EXCLUDED.open_fill_price`,
      // only update if current status is earlier in lifecycle
    }
  })

// Update: guard with current status to prevent going backwards
await db.update(trades)
  .set({ status: 'closed', pnl: '100' })
  .where(and(
    eq(trades.trade_id, tradeId),
    eq(trades.status, 'waiting_targets'),  // only close if currently open
  ))
```

---

## 8. Task Checklist

### Phase A — Redis HA (1 hour)
- [ ] Create Upstash Redis instance
- [ ] Update `REDIS_URL` in Railway environment
- [ ] Verify workers reconnect after Redis restart
- [ ] Delete self-hosted Railway Redis service

### Phase B — DLQ (half day)
- [ ] Add DLQ push to all DB writes in `gateWorkerRunner.ts`
- [ ] Add DLQ push to all DB writes in `okxWorkerRunner.ts`
- [ ] Add DLQ push to all DB writes in `hyperliquidWorkerRunner.ts`
- [ ] Add DLQ push to all DB writes in `tokocryptoWorkerRunner.ts`
- [ ] Implement `DLQWorker.ts` with retry loop and dead letter
- [ ] Add DLQ size to health check response
- [ ] Test: simulate DB failure → verify DLQ populated → verify retry succeeds

### Phase C — ReconcileCron (half day)
- [ ] Implement `ReconcileCron.ts` with 60s interval and per-exchange mutex
- [ ] Implement `GateAdapter.reconcileAll()` for waiting_position and waiting_targets
- [ ] Implement `OKXAdapter.reconcileAll()`
- [ ] Implement `HyperliquidAdapter.reconcileAll()`
- [ ] Implement `TokocryptoAdapter.reconcileAll()`
- [ ] Log correction count and latency per run
- [ ] Test: simulate missed WS event → verify reconcile corrects within 60s

### Phase D — Streams (1 day, do with WorkerManager refactor)
- [ ] Replace `redis.publish('ws-control', ...)` in all executors with `redis.xadd`
- [ ] Implement stream consumer in each worker (replace `control.subscribe`)
- [ ] Implement `XAUTOCLAIM` on worker startup for pending messages
- [ ] Add `exchange` field to all executor Redis publishes (already in WORKER_REFACTOR_SPEC)
- [ ] Test: worker down for 30s → bring back up → verify pending commands processed

### Phase E — Idempotency
- [ ] Add `onConflictDoUpdate` to `gateExecutor.ts` insert
- [ ] Add `onConflictDoUpdate` to all other executor inserts
- [ ] Add status guard to all worker DB updates (prevent backwards state transitions)
- [ ] Test: replay same DLQ event twice → verify no duplicate trade

---

## 9. Definition of Done

- [ ] Redis restart → workers reconnect, no trade commands lost
- [ ] DB failure → event pushed to DLQ → retried and applied within 30s
- [ ] Worker crash during active trade → reconcile corrects state within 60s
- [ ] Signal published while worker is down → replayed when worker comes back (Streams)
- [ ] Replaying a DLQ event twice → no duplicate DB records
- [ ] `GET /health` shows DLQ sizes for all exchanges

---

## 10. What This Does NOT Cover

- **Exchange API downtime** — if Gate.io REST is down, reconcile can't correct. Mitigation: circuit breaker per exchange (Phase 4 of WORKER_REFACTOR_SPEC).
- **Multi-region failover** — single Railway region. Mitigation: not needed at current scale.
- **Order placement failures** — if the executor fails after placing the order but before writing to DB, trade is orphaned on the exchange. Mitigation: idempotent order placement with client order IDs (future).
