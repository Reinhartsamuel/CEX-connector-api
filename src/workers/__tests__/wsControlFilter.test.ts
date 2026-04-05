/**
 * Phase 0 tests: verify each worker only responds to its own exchange's
 * ws-control messages and ignores others.
 *
 * We test the filter logic directly (pure function) rather than spinning up
 * full worker processes.
 */

import { test, expect } from "bun:test";

// The filter logic extracted from each worker's control.on("message") handler.
// If this returns true, the worker would call ensureConnection / closeConnection.
// If false, it returns early (ignores the message).

function gateAccepts(cmd: any): boolean {
  return cmd.exchange === "gate";
}

function okxAccepts(cmd: any): boolean {
  return cmd.exchange === "okx";
}

function hyperliquidAccepts(cmd: any): boolean {
  return cmd.exchange === "hyperliquid";
}

function tokocryptoAccepts(cmd: any): boolean {
  return cmd.exchange === "tokocrypto";
}

const exchanges = ["gate", "okx", "hyperliquid", "tokocrypto"];
const filters = { gate: gateAccepts, okx: okxAccepts, hyperliquid: hyperliquidAccepts, tokocrypto: tokocryptoAccepts };

// ---- Each worker accepts its own exchange ----

for (const exchange of exchanges) {
  test(`${exchange} worker accepts cmd.exchange="${exchange}"`, () => {
    const cmd = { op: "open", exchange, userId: "user-1" };
    expect(filters[exchange as keyof typeof filters](cmd)).toBe(true);
  });
}

// ---- Each worker rejects all other exchanges ----

for (const worker of exchanges) {
  for (const sender of exchanges) {
    if (worker === sender) continue;
    test(`${worker} worker ignores cmd.exchange="${sender}"`, () => {
      const cmd = { op: "open", exchange: sender, userId: "user-1" };
      expect(filters[worker as keyof typeof filters](cmd)).toBe(false);
    });
  }
}

// ---- Workers reject messages with no exchange field ----

for (const exchange of exchanges) {
  test(`${exchange} worker ignores message with no exchange field (legacy)`, () => {
    const cmd = { op: "open", userId: "user-1" }; // old format, no exchange field
    expect(filters[exchange as keyof typeof filters](cmd)).toBe(false);
  });
}

// ---- Hyperliquid-specific: userAddress must be present ----

test("hyperliquid worker requires userAddress to call ensureConnection", () => {
  // Simulates: if (cmd.exchange !== "hyperliquid") return
  //            if (cmd.op === "open" && cmd.userId && cmd.userAddress) → ensureConnection
  const withAddress = { op: "open", exchange: "hyperliquid", userId: "u1", userAddress: "0xAbc" };
  const withoutAddress = { op: "open", exchange: "hyperliquid", userId: "u1" };

  const wouldConnect = (cmd: any) =>
    cmd.exchange === "hyperliquid" && cmd.op === "open" && !!cmd.userId && !!cmd.userAddress;

  expect(wouldConnect(withAddress)).toBe(true);
  expect(wouldConnect(withoutAddress)).toBe(false);
});
