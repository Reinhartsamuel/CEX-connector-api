/**
 * Phase D tests: verify each executor writes to the correct ws-control stream
 * when a BUY/SELL signal is received (Redis Streams, not pub/sub).
 *
 * All external dependencies (Redis, DB, exchange services) are mocked so these
 * tests run without any live connections.
 */

import { test, expect, mock, beforeEach } from "bun:test";

// ---- Shared mock state ----
// Each entry: { stream, fields } where fields is the flat key-value array passed to XADD
const streamMessages: Array<{ stream: string; fields: Record<string, string> }> = [];

// ---- Mock: Redis ----
mock.module("../../db/redis", () => ({
  default: {
    // xadd(stream, id, ...fields) — fields are interleaved key/value strings
    xadd: async (stream: string, _id: string, ...fields: string[]) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
      streamMessages.push({ stream, fields: obj });
      return "1-0";
    },
    hset: async () => {},
  },
}));

// ---- Mock: DB ----
mock.module("../../db/client", () => ({
  postgresDb: {
    insert: () => ({ values: () => Promise.resolve() }),
    query: { trades: { findMany: async () => [] } },
    transaction: async (fn: any) => fn({ update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) }),
  },
}));

// ---- Mock: GateServices ----
mock.module("../../services/gateServices", () => ({
  GateServices: {
    initialize: () => {},
    clearCredentials: () => {},
    updateLeverage: async () => ({}),
    updateMarginMode: async () => ({}),
    placeFuturesOrder: async () => ({
      id: 123456789,
      id_string: "123456789",
      contract: "BTC_USDT",
      size: 1,
      status: "finished",
      finish_as: "filled",
      left: 0,
      fill_price: "50000",
      finish_time: String(Math.floor(Date.now() / 1000)),
      user: "test-user",
    }),
    triggerPriceOrder: async () => ({}),
  },
}));

// ---- Mock: OkxServices ----
mock.module("../../services/okxServices", () => ({
  OkxServices: {
    initialize: () => {},
    clearCredentials: () => {},
    placeOrder: async () => ({
      code: "0",
      data: [{ ordId: BigInt("987654321"), sCode: "0" }],
    }),
  },
}));

// ---- Mock: HyperliquidServices ----
mock.module("../../services/hyperliquidServices", () => ({
  HyperliquidServices: {
    initialize: () => {},
    clearCredentials: () => {},
    updateLeverage: async () => ({}),
    getAssetMetadata: async () => ({ index: 0, szDecimals: 3, name: "BTC" }),
    formatHyperliquidSize: (size: number, dec: number) => size.toFixed(dec),
    formatHyperliquidPrice: (price: number) => String(price),
    placeOrder: async () => ({
      status: "ok",
      response: { data: { statuses: [{ filled: { oid: 111, avgPx: "50000" } }] } },
    }),
  },
}));

// ---- Mock: TokocryptoServices ----
mock.module("../../services/tokocryptoServices", () => ({
  TokocryptoServices: {
    initialize: () => {},
    clearCredentials: () => {},
    updateLeverage: async () => ({}),
    updateMarginMode: async () => ({}),
    placeOrder: async () => ({ id: "toko-order-1", status: "closed", average: "50000" }),
    mapCcxtStatusToDb: () => "waiting_targets",
  },
}));

// ---- Mock: BitgetServices ----
mock.module("../../services/bitgetServices", () => ({
  BitgetServices: {
    initialize: () => {},
    clearCredentials: () => {},
    updateLeverage: async () => ({}),
    updateMarginMode: async () => ({}),
    placeOrder: async () => ({ id: "bitget-order-1", status: "closed", average: "50000" }),
    mapCcxtStatusToDb: () => "waiting_targets",
  },
}));

// ---- Mock: MexcServices ----
mock.module("../../services/mexcServices", () => ({
  MexcServices: {
    initialize: () => {},
    clearCredentials: () => {},
    updateLeverage: async () => ({}),
    updateMarginMode: async () => ({}),
    placeOrder: async () => ({ id: "mexc-order-1", status: "closed", average: "50000" }),
    mapCcxtStatusToDb: () => "waiting_targets",
  },
}));

// ---- Mock: BitmartServices ----
mock.module("../../services/bitmartServices", () => ({
  BitmartServices: {
    initialize: () => {},
    clearCredentials: () => {},
    updateLeverage: async () => ({}),
    placeOrder: async () => ({ id: "bitmart-order-1", status: "closed", average: "50000" }),
    mapCcxtStatusToDb: () => "waiting_targets",
  },
}));

// ---- Mock: wsReady ----
mock.module("../../utils/wsReady", () => ({
  waitForWsReady: async () => {},
  publishWsReady: async () => {},
}));

// ---- Shared fixture ----
function makeCtx(exchangeUserId: string, symbol: string) {
  return {
    autotrader: {
      id: 1,
      user_id: 1,
      exchange_id: 1,
      symbol,
      leverage: 10,
      leverage_type: "ISOLATED",
      initial_investment: "1",
      contract_value_multiplier: "1",
      status: "active",
    } as any,
    exchange: { id: 1, exchange_title: "gate" } as any,
    api_key: "test-key",
    api_secret: "test-secret",
    api_passphrase: "test-passphrase",
    exchange_user_id: exchangeUserId,
    action: "BUY" as const,
    overrides: { order_type: "market" as const, market_price: 50000 },
  };
}

beforeEach(() => {
  streamMessages.length = 0;
});

// ============================================================
// Gate
// ============================================================
test("GateExecutor writes to global and legacy streams with exchange field", async () => {
  const { GateExecutor } = await import("../gateExecutor");
  const ctx = makeCtx("gate-user-123", "BTC_USDT");

  await GateExecutor.execute(ctx);

  const globalMsg = streamMessages.find((m) => m.stream === "ws-control");
  const legacyMsg = streamMessages.find((m) => m.stream === "ws-control:gate");

  expect(globalMsg).toBeDefined();
  expect(globalMsg!.fields.op).toBe("open");
  expect(globalMsg!.fields.exchange).toBe("gate");
  expect(globalMsg!.fields.userId).toBe("gate-user-123");

  expect(legacyMsg).toBeDefined();
  expect(legacyMsg!.fields.exchange).toBe("gate");
});

// ============================================================
// OKX
// ============================================================
test("OkxExecutor writes exchange-routable global control message", async () => {
  const { OkxExecutor } = await import("../okxExecutor");
  const ctx = makeCtx("okx-user-456", "BTC-USDT-SWAP");

  await OkxExecutor.execute(ctx);

  const globalMsg = streamMessages.find((m) => m.stream === "ws-control" && m.fields.exchange === "okx");
  expect(globalMsg).toBeDefined();
  expect(globalMsg!.fields.op).toBe("open");
  expect(globalMsg!.fields.userId).toBe("okx-user-456");
});

// ============================================================
// Hyperliquid
// ============================================================
test("HyperliquidExecutor writes exchange-routable global control message", async () => {
  const { HyperliquidExecutor } = await import("../hyperliquidExecutor");
  const ctx = makeCtx("0xWalletAddress", "BTC");

  await HyperliquidExecutor.execute(ctx);

  const globalMsg = streamMessages.find((m) => m.stream === "ws-control" && m.fields.exchange === "hyperliquid");
  expect(globalMsg).toBeDefined();
  expect(globalMsg!.fields.op).toBe("open");
  expect(globalMsg!.fields.userId).toBe("0xWalletAddress");
  expect(globalMsg!.fields.userAddress).toBe("0xWalletAddress");
});

// ============================================================
// Tokocrypto
// ============================================================
test("TokocryptoExecutor writes exchange-routable global control message", async () => {
  const { TokocryptoExecutor } = await import("../tokocryptoExecutor");
  const ctx = makeCtx("toko-user-789", "BTC/USDT");

  await TokocryptoExecutor.execute(ctx);

  const globalMsg = streamMessages.find((m) => m.stream === "ws-control" && m.fields.exchange === "tokocrypto");
  expect(globalMsg).toBeDefined();
  expect(globalMsg!.fields.op).toBe("open");
  expect(globalMsg!.fields.userId).toBe("toko-user-789");
});

// ============================================================
// Bitget
// ============================================================
test("BitgetExecutor writes exchange-routable global control message", async () => {
  const { BitgetExecutor } = await import("../bitgetExecutor");
  const ctx = makeCtx("bitget-user-001", "BTC/USDT:USDT");

  await BitgetExecutor.execute(ctx);

  const globalMsg = streamMessages.find((m) => m.stream === "ws-control" && m.fields.exchange === "bitget");
  expect(globalMsg).toBeDefined();
  expect(globalMsg!.fields.op).toBe("open");
  expect(globalMsg!.fields.userId).toBe("bitget-user-001");
});

// ============================================================
// MEXC
// ============================================================
test("MexcExecutor writes exchange-routable global control message", async () => {
  const { MexcExecutor } = await import("../mexcExecutor");
  const ctx = makeCtx("mexc-user-002", "BTC_USDT");

  await MexcExecutor.execute(ctx);

  const globalMsg = streamMessages.find((m) => m.stream === "ws-control" && m.fields.exchange === "mexc");
  expect(globalMsg).toBeDefined();
  expect(globalMsg!.fields.op).toBe("open");
  expect(globalMsg!.fields.userId).toBe("mexc-user-002");
});

// ============================================================
// BitMart
// ============================================================
test("BitmartExecutor writes exchange-routable global control message", async () => {
  const { BitmartExecutor } = await import("../bitmartExecutor");
  const ctx = makeCtx("bitmart-user-003", "BTCUSDT");

  await BitmartExecutor.execute(ctx);

  const globalMsg = streamMessages.find((m) => m.stream === "ws-control" && m.fields.exchange === "bitmart");
  expect(globalMsg).toBeDefined();
  expect(globalMsg!.fields.op).toBe("open");
  expect(globalMsg!.fields.userId).toBe("bitmart-user-003");
});

// ============================================================
// CLOSE action — no stream write expected
// ============================================================
test("GateExecutor does not write to ws-control stream on CLOSE", async () => {
  const { GateExecutor } = await import("../gateExecutor");
  const ctx = { ...makeCtx("gate-user-123", "BTC_USDT"), action: "CLOSE" as const };

  await GateExecutor.execute(ctx);

  const msg = streamMessages.find((m) => m.fields.op === "open");
  expect(msg).toBeUndefined();
});
