# Observability Stack

Self-hosted LGTM stack: **Loki** (logs) · **Grafana** (dashboards) · **Tempo** (traces, ready for future use) · **Mimir** (metrics/Prometheus-compat) · **Alloy** (metrics scraper).

All services run via Docker Compose on a VPS. The API ships logs directly to Loki over HTTP (`pino-loki`) and exposes a Prometheus `/metrics` endpoint that Alloy scrapes into Mimir.

---

## Development

### 1. Start the stack locally

```bash
cd observability
docker compose up -d
```

Services:
| Service  | URL                        |
|----------|----------------------------|
| Grafana  | http://localhost:3000       |
| Loki     | http://localhost:3100       |
| Mimir    | http://localhost:9009       |
| Tempo    | http://localhost:3200       |
| Alloy    | http://localhost:12345      |

### 2. Run the API with log shipping

```bash
# In the repo root
LOKI_URL=http://localhost:3100 bun run src/index.ts | bunx pino-pretty
```

- Logs go to **stdout** (pretty-printed) AND to **Loki** simultaneously.
- Without `LOKI_URL`, logs go to stdout only.

### 3. View logs in Grafana

1. Open http://localhost:3000
2. Go to **Explore** → select **Loki** datasource
3. Query: `{app="byscript-api"}` — shows all processes
4. Filter by process: `{app="byscript-api", process="worker-gate"}`

### 4. View metrics in Grafana

```bash
# Verify the /metrics endpoint is up
curl http://localhost:1122/metrics
```

1. In Grafana → **Explore** → select **Mimir** datasource
2. Query: `trades_opened_total` or `signal_latency_ms_bucket`

> **Note:** Alloy scrapes `host.docker.internal:1122` by default on Mac/Windows.
> On Linux, set `BYSCRIPT_API_HOST=172.17.0.1:1122` (Docker bridge gateway) in your shell before starting Alloy, or edit `alloy-config.river`.

### 5. Stop the stack

```bash
docker compose down
# To also delete all stored data:
docker compose down -v
```

---

## Production (Railway API → VPS LGTM stack)

### Prerequisites

- A VPS with Docker and Docker Compose installed
- Ports open: `3000` (Grafana), `3100` (Loki), `9009` (Mimir) — or use a reverse proxy (nginx/Caddy) with HTTPS

### 1. Deploy the stack on the VPS

```bash
# On your VPS
git clone <this-repo> byscript-connector-api
cd byscript-connector-api/observability
docker compose up -d
```

### 2. Set environment variables on Railway

In your Railway project, add these environment variables:

| Variable         | Value                             | Purpose                                    |
|------------------|-----------------------------------|--------------------------------------------|
| `LOKI_URL`       | `http://<your-vps-ip>:3100`       | Enables pino-loki log shipping to Loki     |
| `LOG_LEVEL`      | `info`                            | Controls log verbosity (debug/info/warn)   |
| `METRICS_TOKEN`  | `<random-secret>`                 | Protects `/metrics` endpoint (optional)    |

> If you set `METRICS_TOKEN` on the API, also set it in the Alloy environment so scraping still works — see step 4.

### 3. Configure Alloy to scrape Railway

Edit `alloy-config.river` on the VPS, replacing the targets block:

```river
prometheus.scrape "byscript_api" {
  targets = [
    { __address__ = "<your-railway-app>.railway.app:443" },
  ]
  metrics_path    = "/metrics"
  scheme          = "https"
  scrape_interval = "15s"
  bearer_token    = env("METRICS_TOKEN")  // matches METRICS_TOKEN on Railway
  forward_to      = [prometheus.remote_write.mimir.receiver]
}
```

Then restart Alloy:

```bash
docker compose restart alloy
```

### 4. (Optional) Secure the stack

By default Grafana has anonymous admin access (fine for a private VPS). To add a login:

```yaml
# In docker-compose.yml, under grafana environment:
- GF_AUTH_ANONYMOUS_ENABLED=false
- GF_SECURITY_ADMIN_USER=admin
- GF_SECURITY_ADMIN_PASSWORD=<strong-password>
```

To put Loki/Mimir behind a reverse proxy with basic auth, use Caddy or nginx in front — Alloy and pino-loki both support `Authorization` headers.

### 5. Verify end-to-end

```bash
# From any machine
curl http://<your-vps-ip>:3100/ready        # Loki: should return "ready"
curl http://<your-vps-ip>:9009/ready        # Mimir: should return "ready"

# Trigger a test webhook on Railway, then check Grafana:
# Explore → Loki → {app="byscript-api"} → should show structured JSON log lines
# Explore → Mimir → trades_opened_total → should increment after each signal
```

---

## Key metrics

| Metric                        | Labels                              | Description                          |
|-------------------------------|-------------------------------------|--------------------------------------|
| `trades_opened_total`         | `exchange`, `action`, `status`      | Signals processed (success/failed)   |
| `trades_closed_total`         | `exchange`                          | Positions closed via WS worker       |
| `signal_latency_ms_bucket`    | `exchange`, `action`                | End-to-end executor latency          |
| `exchange_errors_total`       | `exchange`, `component`             | Errors by exchange and component     |
| `ws_connections_active`       | `exchange`                          | Live WebSocket connections per exchange |
| `reconcile_corrections_total` | `exchange`                          | State corrections made by ReconcileCron |

Default Node.js metrics (CPU, memory, event loop lag) are also collected automatically.

---

## Log labels

Every log line is structured JSON with these fields:

| Field      | Example values                                        |
|------------|-------------------------------------------------------|
| `app`      | `byscript-api`                                        |
| `process`  | `api`, `worker-gate`, `worker-okx`, `reconcile-cron`  |
| `exchange` | `gate`, `okx`, `hyperliquid`, `bitget`, etc.          |
| `level`    | `10`=trace, `20`=debug, `30`=info, `40`=warn, `50`=error |

Useful Loki queries:

```logql
# All errors across all processes
{app="byscript-api"} | json | level >= 50

# Gate worker errors only
{app="byscript-api", process="worker-gate"} | json | level >= 50

# Signal handler — all processed signals
{app="byscript-api"} | json | msg = "Signal processed"

# Slow signals (latency > 1000ms) — join with Mimir histogram instead
rate({app="byscript-api"} | json | msg = "Signal processed" [5m])
```
