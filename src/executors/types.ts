import type { Autotrader, Exchange } from '../db/schema';

export type SignalAction = 'BUY' | 'SELL' | 'CLOSE' | 'CANCEL';
export type PriceType = 'mark' | 'last' | 'index';
export type OrderType = 'market' | 'limit';

// Optional per-signal overrides — everything else comes from the autotrader config
export interface TpSlOverride {
  enabled: boolean;
  price: string;
  price_type: PriceType;
}

export interface SignalOverrides {
  order_type?: OrderType;   // default: 'market'
  price?: number;           // required when order_type = 'limit'
  take_profit?: TpSlOverride;
  stop_loss?: TpSlOverride;
}

// Everything the executor needs — autotrader config + decrypted creds + signal overrides
export interface ExecutorContext {
  autotrader: Autotrader;
  exchange: Exchange;
  api_key: string;
  api_secret: string;
  exchange_user_id: string;
  action: SignalAction;
  overrides: SignalOverrides;
}

export interface ExecutorResult {
  success: boolean;
  exchange_order_id?: string;
  raw?: unknown;
  error?: string;
}

export interface ExchangeExecutor {
  execute(ctx: ExecutorContext): Promise<ExecutorResult>;
}
