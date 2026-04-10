import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

export const tradesOpenedTotal = new Counter({
  name: 'trades_opened_total',
  help: 'Total trade open signals processed',
  labelNames: ['exchange', 'action', 'status'] as const, // status: success | failed
  registers: [metricsRegistry],
});

export const tradesClosedTotal = new Counter({
  name: 'trades_closed_total',
  help: 'Total trades closed by workers',
  labelNames: ['exchange'] as const,
  registers: [metricsRegistry],
});

export const signalLatency = new Histogram({
  name: 'signal_latency_ms',
  help: 'Webhook signal processing latency in milliseconds',
  labelNames: ['exchange', 'action'] as const,
  buckets: [50, 100, 250, 500, 1000, 2500, 5000],
  registers: [metricsRegistry],
});

export const exchangeErrorsTotal = new Counter({
  name: 'exchange_errors_total',
  help: 'Total errors per exchange component',
  labelNames: ['exchange', 'component'] as const, // component: executor | worker | reconcile
  registers: [metricsRegistry],
});

export const wsConnectionsActive = new Gauge({
  name: 'ws_connections_active',
  help: 'Active WebSocket connections per exchange worker',
  labelNames: ['exchange'] as const,
  registers: [metricsRegistry],
});

export const reconcileCorrectionsTotal = new Counter({
  name: 'reconcile_corrections_total',
  help: 'Trade state corrections made by the reconcile cron',
  labelNames: ['exchange'] as const,
  registers: [metricsRegistry],
});
