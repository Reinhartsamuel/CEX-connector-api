import { GateExecutor } from './gateExecutor';
import type { ExchangeExecutor } from './types';

export function getExecutor(exchangeTitle: string): ExchangeExecutor {
  switch (exchangeTitle.toLowerCase()) {
    case 'gate':
      return GateExecutor;
    default:
      throw new Error(`No executor registered for exchange: "${exchangeTitle}"`);
  }
}
