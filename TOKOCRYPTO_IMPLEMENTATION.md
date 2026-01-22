# Tokocrypto Integration - Exchange-Specific Nuances

## Overview
Tokocrypto is built on Binance Cloud infrastructure, so it follows Binance's API patterns. This document explains the key differences between exchanges and how Tokocrypto handles them.

## Leverage, Margin Mode, and Position Mode Comparison

### Gate.io Pattern
```typescript
// Separate API calls
updateMarginMode(contract, "ISOLATED" | "CROSS")
updateLeverage(contract, leverage)

// No position mode concept (single position per contract)
```

### OKX Pattern
```typescript
// Combined API call
set-position-mode({
  instId: contract,
  lever: leverage,
  mgnMode: "ISOLATED" | "CROSS",
  posMode: "long_short_mode" // hedge mode
})

// Position mode options:
// - "long_short_mode": Can hold both long and short simultaneously (hedge)
// - "net_mode": Only one position at a time (one-way)
```

### Tokocrypto (Binance Cloud) Pattern
```typescript
// Three separate API calls (following Binance)
updatePositionMode(hedgeMode: boolean) // true = hedge, false = one-way
updateLeverage(symbol, leverage)
updateMarginMode(symbol, "ISOLATED" | "CROSS")

// Position mode options:
// - hedge mode (dualSidePosition=true): Can hold long and short simultaneously
// - one-way mode (dualSidePosition=false): Only one direction at a time
```

## Implementation Details

### 1. Position Mode (Binance/Tokocrypto Specific)

**API Endpoint**: `POST /fapi/v1/positionSide/dual`

**Parameters**:
- `dualSidePosition`: "true" or "false"
  - `true` = Hedge Mode (can hold both LONG and SHORT positions on the same symbol)
  - `false` = One-Way Mode (can only hold one position direction at a time)

**CCXT Implementation**:
```typescript
await exchange.fapiPrivatePostPositionsideDual({
  dualSidePosition: 'true' // or 'false'
})
```

**When to use Hedge vs One-Way**:
- **Hedge Mode**: Use when you want to simultaneously hold long and short positions (e.g., market making, arbitrage)
- **One-Way Mode**: Use for simple directional trading (most common for retail traders)

### 2. Leverage (Per Symbol)

**API Endpoint**: `POST /fapi/v1/leverage`

**Parameters**:
- `symbol`: Trading pair (e.g., "BTCUSDT")
- `leverage`: Integer (1-125 depending on symbol)

**CCXT Implementation**:
```typescript
await exchange.setLeverage(leverage, symbol)
```

**Important Notes**:
- Leverage is set **per symbol**, not globally
- Each symbol has different maximum leverage limits
- Higher leverage = higher liquidation risk

### 3. Margin Mode (Per Symbol)

**API Endpoint**: `POST /fapi/v1/marginType`

**Parameters**:
- `symbol`: Trading pair
- `marginType`: "ISOLATED" or "CROSS"

**CCXT Implementation**:
```typescript
await exchange.setMarginMode('ISOLATED', symbol)
// or
await exchange.setMarginMode('CROSS', symbol)
```

**Isolated vs Cross**:
- **ISOLATED**: Margin is limited to the position. If liquidated, only the position's margin is lost.
- **CROSS**: Uses all available balance as margin. If liquidated, entire account balance can be lost.

## Order Placement Flow

### Tokocrypto Order Sequence:
```
1. Set Position Mode (hedge or one-way) [once per account]
   ↓
2. Set Leverage for Symbol (e.g., 10x for BTCUSDT)
   ↓
3. Set Margin Mode for Symbol (ISOLATED or CROSS)
   ↓
4. Place Order (with TP/SL if needed)
```

### Example Request:
```json
{
  "exchange_id": 1,
  "autotrader_id": 1,
  "contract": "BTC/USDT",
  "market": "futures",
  "market_type": "market",
  "position_type": "long",
  "position_mode": "hedge",     // NEW: hedge or one-way
  "size": 0.001,
  "leverage": 10,                // Per-symbol leverage
  "leverage_type": "ISOLATED",   // Per-symbol margin mode
  "reduce_only": false,
  "take_profit": {
    "enabled": true,
    "price": 45000,
    "price_type": "mark"
  },
  "stop_loss": {
    "enabled": true,
    "price": 42000,
    "price_type": "mark"
  }
}
```

## Key Differences from Other Exchanges

### Gate.io
- ✅ Has margin mode (ISOLATED/CROSS)
- ✅ Has leverage per contract
- ❌ No explicit position mode (always one-way)

### OKX
- ✅ Has position mode (long_short_mode = hedge)
- ✅ Has margin mode (ISOLATED/CROSS)
- ✅ Has leverage per contract
- 🔄 All set in ONE API call

### Tokocrypto (Binance Cloud)
- ✅ Has position mode (hedge/one-way)
- ✅ Has margin mode (ISOLATED/CROSS)
- ✅ Has leverage per symbol
- 🔄 THREE separate API calls

### Hyperliquid
- ✅ Has leverage per asset
- ✅ Has margin mode (ISOLATED/CROSS)
- ❌ No explicit position mode (native hedge support)

## Error Handling

### Common Errors:

1. **Position mode conflicts**:
   - Error: "Position mode cannot be changed when there are open positions"
   - Solution: Close all positions first, or skip position mode update

2. **Leverage too high**:
   - Error: "Leverage is over the maximum leverage"
   - Solution: Check symbol's max leverage via `exchange.fetchLeverageTiers()`

3. **Margin mode locked**:
   - Error: "Margin type cannot be changed if there is open order or position"
   - Solution: Cancel orders and close positions first

## Best Practices

1. **Cache position mode**: Position mode is account-level, so it doesn't need to be set on every order
2. **Validate leverage limits**: Different symbols have different max leverage (BTC: 125x, altcoins: 20-50x)
3. **Use ISOLATED for risky trades**: Protects your account from total liquidation
4. **Default to hedge mode**: More flexible, matches OKX's behavior
5. **Handle errors gracefully**: Setting these parameters can fail if positions are open

## Testing Checklist

- [ ] Test position mode: hedge mode (can open long + short simultaneously)
- [ ] Test position mode: one-way mode (only one direction)
- [ ] Test leverage: 1x, 10x, 50x, 125x (if supported)
- [ ] Test margin mode: ISOLATED vs CROSS
- [ ] Test leverage changes with open positions (should fail)
- [ ] Test margin mode changes with open positions (should fail)
- [ ] Test TP/SL with different price types (mark, last, index)
- [ ] Verify PnL calculation matches exchange

## Reference Documentation

- [Binance Futures API - Position Mode](https://binance-docs.github.io/apidocs/futures/en/#change-position-mode-trade)
- [Binance Futures API - Leverage](https://binance-docs.github.io/apidocs/futures/en/#change-initial-leverage-trade)
- [Binance Futures API - Margin Type](https://binance-docs.github.io/apidocs/futures/en/#change-margin-type-trade)
- [CCXT Tokocrypto Documentation](https://docs.ccxt.com/en/latest/manual.html#tokocrypto)
