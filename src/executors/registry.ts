import { GateExecutor } from './gateExecutor';
import { OkxExecutor } from './okxExecutor';
import { HyperliquidExecutor } from './hyperliquidExecutor';
import { TokocryptoExecutor } from './tokocryptoExecutor';
import { BitgetExecutor } from './bitgetExecutor';
import { MexcExecutor } from './mexcExecutor';
import { BitmartExecutor } from './bitmartExecutor';
import type { ExchangeExecutor } from './types';

export function getExecutor(exchangeTitle: string): ExchangeExecutor {
  switch (exchangeTitle.toLowerCase()) {
    case 'gate':
      return GateExecutor;
    case 'okx':
      return OkxExecutor;
    case 'hyperliquid':
      return HyperliquidExecutor;
    case 'tokocrypto':
      return TokocryptoExecutor;
    case 'bitget':
      return BitgetExecutor;
    case 'mexc':
      return MexcExecutor;
    case 'bitmart':
      return BitmartExecutor;
    default:
      throw new Error(`No executor registered for exchange: "${exchangeTitle}"`);
  }
}
