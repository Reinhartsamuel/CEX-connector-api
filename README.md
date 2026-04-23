# byscript-connector-api

A self-hosted trading automation backend. Connect your exchange accounts, configure bots, and automate futures trades via webhooks from TradingView or any HTTP client.

Think 3Commas or Pionex — but open-source and running on your own infrastructure.

---

## What it does

- Receive trading signals via webhook (TradingView alerts, custom scripts, etc.)
- Execute futures orders on connected exchanges automatically
- Track trade lifecycle: from order placement through fill to position close
- Manage multiple exchange accounts per user, credentials encrypted with AWS KMS

**Supported exchanges:** Gate.io, OKX, Hyperliquid, Tokocrypto, Bitget, MEXC, BitMart

---

## How it works

```
Signal (TradingView / HTTP)
        │
        ▼
POST /webhook/signal  { token, action: "BUY" | "SELL" | "CLOSE" }
        │
        ▼
Validates token → loads autotrader config → decrypts exchange credentials
        │
        ▼
Exchange Executor  (places order via REST, writes trade to DB)
        │
        ▼ (async, separate process)
Exchange Worker   (listens to exchange WebSocket → updates trade status in DB)
```

Trades progress through these states: `waiting_position` → `waiting_targets` → `closed`

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh) |
| Framework | [Hono](https://hono.dev) |
| Database | PostgreSQL + [Drizzle ORM](https://orm.drizzle.team) |
| Cache / Pub-Sub | Redis (ioredis) |
| Credential encryption | AWS KMS (KEK-DEK model) |
| Auth | Firebase Authentication |

---

## Prerequisites

- Bun >= 1.0
- PostgreSQL
- Redis
- AWS account with a KMS key (for credential encryption)
- Firebase project (for user auth)
- API keys for whichever exchanges you want to connect

---

## Setup

**1. Install dependencies**
```bash
bun install
```

**2. Configure environment**

Create a `.env` file:
```env
PORT=1122
DATABASE_URL=postgresql://user:password@localhost:5432/byscript
REDIS_URL=redis://localhost:6379
CORS_ORIGIN=http://localhost:5173

# AWS KMS
AWS_REGION=ap-southeast-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
KMS_KEY_ID=...

# Firebase
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY=...
```

**3. Run database migrations**
```bash
bun run db:push
```

**4. Start the API server**
```bash
bun run src/index.ts
```

**5. Start worker manager**
```bash
bun run start:worker-manager
```

WorkerManager runs all exchange adapters in one process, routes control commands, runs internal reconciliation, and serves worker health/metrics endpoints.

Server runs on `http://localhost:1122` by default.

---

## Webhook payload

Send `POST /webhook/signal`:

```json
{
  "token": "your-autotrader-webhook-token",
  "action": "BUY",
  "order_type": "market",
  "take_profit": {
    "enabled": true,
    "price": "68000",
    "price_type": "mark"
  },
  "stop_loss": {
    "enabled": true,
    "price": "62000",
    "price_type": "mark"
  }
}
```

| Field | Required | Values |
|-------|----------|--------|
| `token` | Yes | Per-autotrader webhook token |
| `action` | Yes | `BUY`, `SELL`, `CLOSE`, `CANCEL` |
| `order_type` | No | `market` (default) or `limit` |
| `price` | If limit | Entry price |
| `take_profit.price_type` | If TP enabled | `mark`, `last`, `index` |
| `stop_loss.price_type` | If SL enabled | `mark`, `last`, `index` |

The API responds immediately with `200 OK`. Execution happens asynchronously.

---

## API overview

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhook/signal` | Receive and execute a trading signal |
| `GET` | `/health` | Health check (DB + Redis latency) |
| `GET` | `/autotraders` | List autotrader configurations |
| `POST` | `/autotraders` | Create autotrader |
| `GET` | `/user/trades` | Trade history |
| `GET` | `/sse/trades` | Real-time trade updates (Server-Sent Events) |
| `POST` | `/gate/register-user` | Register Gate.io account |
| `POST` | `/okx/register-user` | Register OKX account |
| `POST` | `/hyperliquid/register-user` | Register Hyperliquid account |
| `POST` | `/tokocrypto/register-user` | Register Tokocrypto account |

All routes except `/webhook/signal` and `/health` require a Firebase JWT: `Authorization: Bearer <token>`

---

## Autotrader (bot configuration)

An autotrader defines one bot on one exchange for one trading pair.

| Field | Description |
|-------|-------------|
| `symbol` | Trading pair in exchange format (`BTC_USDT` for Gate, `BTC-USDT-SWAP` for OKX) |
| `exchange_id` | Which connected exchange account to use |
| `initial_investment` | Contract size (number of contracts) |
| `leverage` | Leverage multiplier |
| `leverage_type` | `ISOLATED` or `CROSS` |
| `position_mode` | `hedge` or `one-way` |
| `webhook_token` | Token for authenticating incoming signals |
| `status` | `active`, `inactive`, or `paused` |

---

## Credential security

Exchange API keys are never stored in plaintext:

1. A random DEK (data encryption key) is generated per exchange connection
2. The DEK is encrypted with your AWS KMS master key and stored in the database
3. API keys and secrets are encrypted with the DEK
4. On each trade, the KMS key decrypts the DEK at runtime — plaintext keys exist only in memory for the duration of the request

Compromising the database alone is not sufficient to recover API keys.

---

## Exchange notes

**Gate.io** — fully tested end-to-end
- Symbol format: `BTC_USDT`
- TP/SL as separate trigger price orders

**OKX** — implemented, lifecycle testing in progress
- Symbol format: `BTC-USDT-SWAP`
- TP/SL inline in order payload via `attachAlgoOrds`

**Hyperliquid** — implemented, lifecycle testing in progress
- Uses agent private key (not API key/secret)
- TP/SL as separate reduce-only limit orders

**Tokocrypto** — implemented, lifecycle testing in progress
- Binance Cloud infrastructure, follows Binance Futures API
- Requires three pre-order calls: position mode, leverage, margin mode

**Bitget** — implemented, lifecycle testing in progress
- Uses CCXT + API passphrase
- WebSocket-driven order/position updates

**MEXC** — implemented, lifecycle testing in progress
- Uses CCXT without passphrase
- WebSocket-driven order/position updates

**BitMart** — implemented, lifecycle testing in progress
- Uses CCXT + memo/uid passphrase
- WebSocket-driven order/position updates

---

## Project status

Gate.io is the reference implementation with a fully tested trade lifecycle. The other exchanges have executors and workers implemented but are not yet fully tested end-to-end.

Actively working on:
- High-availability: Redis Streams for at-least-once delivery, dead letter queue for failed DB writes, periodic reconciliation
- Worker architecture consolidation: single `WorkerManager` process instead of 4 separate workers
- Structured logging with pino

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

---

## License

MIT
