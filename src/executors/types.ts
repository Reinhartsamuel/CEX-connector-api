import type { Autotrader, Exchange } from '../db/schema';

export type SignalAction = 'BUY' | 'SELL' | 'CLOSE' | 'CANCEL';

// Everything the executor needs — all sourced from the autotrader config + decrypted creds
export interface ExecutorContext {
  autotrader: Autotrader;
  exchange: Exchange;
  api_key: string;
  api_secret: string;
  exchange_user_id: string;
  encrypted_api_key: string;
  encrypted_api_secret: string;
  action: SignalAction;
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
