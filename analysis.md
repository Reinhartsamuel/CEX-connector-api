# Source Code Analysis

## 1. Critical Bugs & Data Integrity Risks (Fix Before Launch)

### Race condition: order fills before WS worker connects

In gateExecutor.ts:99-109, you publish ws-control after placing the
order. If the order fills instantly (market orders), the WS worker
hasn't connected yet and misses the fill event. The trade stays
waiting_position forever. OKX worker even has a comment about this at
line 59: 🚨 CRITICAL: FETCH SNAPSHOT HERE TO FIX RACE CONDITION 🚨 but
it's not implemented.

Fix: After WS connects and subscribes, immediately poll open
orders/positions via REST to reconcile any events missed during the
connection gap.

### Gate worker: exchange!.id can NPE

gateWorkerRunner.ts:529 --- exchange!.id with a non-null assertion. If
the exchange record doesn't exist (deleted account, wrong
exchange_user_id mapping), this crashes the entire worker process,
killing all user connections on that worker.

### Position close updates ALL matching trades, not just one

gateWorkerRunner.ts:517-537 --- The position_closed handler updates
every trade with status=waiting_targets for that contract+exchange. If a
user has multiple trades on the same pair (scaling in), they all get
marked closed with the same PnL. This is wrong --- you need to match the
specific trade.

### No DB transactions in Gate worker

Gate worker does multiple related DB writes (status updates, PnL writes)
without transactions. A crash mid-update leaves trades in inconsistent
state. Hyperliquid worker correctly uses postgresDb.transaction() at
line 425 --- Gate doesn't.

### Plaintext API keys in Redis

gateExecutor.ts:100-104 stores encrypted_api_key and
encrypted_api_secret in Redis, but the Gate worker reads them at line
51-53 and passes them directly as credentials --- no decryption step.
Either these are actually plaintext (security issue) or the worker is
sending encrypted blobs to Gate's API (it would just fail). OKX worker
imports KMS decrypt but the getDecryptedCreds function body is empty
(line 14-16).

------------------------------------------------------------------------

## 2. Missing Critical Systems (Non-Existent But Required)

### No idempotency

If a webhook fires twice (TradingView retries, network glitch), you'll
open duplicate positions. There's no dedup key or idempotency check
anywhere in the executor flow.

### No rate limiting per user

A user with a misconfigured TradingView alert could fire hundreds of
webhooks/second. No throttle or queue exists. This also risks hitting
exchange API rate limits which can get the user's API key banned.

### No dead letter queue / retry mechanism

If a DB write fails during handlePositionItem or processFill, the event
is logged and lost forever. No retry, no DLQ, no way to replay failed
events.

### No health monitoring or alerting

Workers run as standalone processes with console.log. No health checks,
no metrics (connection count, event throughput, error rate), no alerting
when a worker dies or a user's connection has been down for X minutes.

### No order/position reconciliation loop

If a WS disconnects for 5 seconds, events during that window are lost.
There's no periodic REST poll to reconcile actual exchange state with
your DB state. This is the #1 cause of "phantom trades" on platforms
like this.

### No user notification system

When a trade fills, closes, or errors --- the user has no way to know
other than refreshing the dashboard. No push notifications, no email
alerts, no in-app toast.

### No audit trail

order_updates table exists in the schema but is never written to from
any worker. You have no event log for debugging user complaints.

------------------------------------------------------------------------

## 3. Technical Debt & Code Quality

  ----------------------------------------------------------------------------------
  Issue                   Location                  Impact
  ----------------------- ------------------------- --------------------------------
  Debug emoji spam        Gate worker throughout    Noisy logs, impossible to grep
  (🤮🤮🤮, 😭🚀🤮🔥)                                in production

  any types everywhere    All workers (OrderItem =  No compile-time safety for
                          any, PositionItem = any)  exchange payloads

  OKX worker is a         okxWorkerRunner.ts        Entire exchange integration
  skeleton                                          incomplete

  No shared worker        All 3 workers             80% duplicate code (Redis setup,
  abstraction                                       backoff, ping, reconnect,
                                                    shutdown). Each bug must be
                                                    fixed 3x

  computeSize is a stub   gateExecutor.ts:263-265   Just does
                                                    Math.floor(initial_investment)
                                                    --- ignores contract multiplier,
                                                    price, notional value. Will be
                                                    wildly wrong for most contracts

  Reconnect after         gateWorkerRunner.ts:334   onWsClose fires after
  closeConnection                                   intentional close and schedules
                                                    reconnect. Should check if close
                                                    was intentional

  decimal(10,2) for       schema.ts:74,81           Max value 99,999,999.99 --- a
  balances/PnL                                      single BTC position at \$100k
                                                    leverage 10x overflows this

  Duplicate relations     schema.ts:265-274 and     tradesRelations and
  definitions             341-352                   trades_relations both define
                                                    relations for trades --- one
                                                    will override the other

  No indexes on           schema.ts                 Every WS event does WHERE
  trades.trade_id or                                trade_id = ? --- full table scan
  trades.status                                     as trades grow
  ----------------------------------------------------------------------------------

------------------------------------------------------------------------

## 4. Production Readiness Scorecard

  -----------------------------------------------------------------------
  Category                Status                  Notes
  ----------------------- ----------------------- -----------------------
  Core order execution    \~70%                   Works for happy path.
                                                  Limit orders, partial
                                                  fills, edge cases
                                                  incomplete

  Trade lifecycle         \~50%                   Gate partially works,
  tracking                                        Hyperliquid decent, OKX
                                                  skeleton

  Data integrity          \~30%                   No transactions (Gate),
                                                  no idempotency, race
                                                  conditions

  Error recovery          \~20%                   No DLQ, no
                                                  reconciliation, lost
                                                  events on disconnect

  Security                \~40%                   KMS exists but Redis
                                                  cred storage is unclear

  Observability           \~10%                   Console.log only

  Scalability             \~30%                   Single-process workers,
                                                  all connections in
                                                  memory Map

  Multi-exchange parity   \~40%                   Gate \~70%, Hyperliquid
                                                  \~60%, OKX \~10%
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## 5. Priority Order for Safe Beta Launch

1.  Fix the race condition --- snapshot reconciliation after WS connect
2.  Add idempotency to webhook/executor layer
3.  Add trades.trade_id and trades.status DB indexes
4.  Wrap Gate worker DB ops in transactions
5.  Fix the "close updates all trades" bug in Gate position handler
6.  Add a reconciliation cron --- every 60s, poll REST for open
    positions and compare to DB
7.  Structured logging --- replace console.log with pino/winston, add
    correlation IDs
8.  Extract a shared BaseWorker class --- DRY up the 3 workers
9.  Health check endpoint per worker process
10. Finish OKX worker

------------------------------------------------------------------------

## Timeline

You're probably **4--6 focused weeks** from a closed beta with a small
group of trusted users, assuming items 1--6 are addressed.

A public launch with real money requires items 7--10 plus load testing
and a proper incident runbook.
