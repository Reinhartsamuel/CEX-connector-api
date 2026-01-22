export interface WebSocketAuthOptions {
  channel: string;
  event: string;
  timestamp?: number;
}

export interface GateCredentials {
  key: string;
  secret: string;
}
export interface GateServiceConfig {
  credentials: GateCredentials;
  baseUrl: string;
}

export interface GateFuturesOrder {
  contract: string;
  size: number;
  price: string;
  tif: string;
  iceberg: number;
  reduce_only: boolean;
  auto_size: string;
  settle: string;
}

interface InitialTriggerPriceOrderRequest {
  contract: string;
  size: number;
  price: string;
  tif: string;
  auto_size: string;
  reduce_only?: boolean;
}
interface Trigger {
  strategy_type: number;
  price_type: number;
  price: string;
  rule: number;
}

export interface GateTriggerPriceOrder {
  initial: InitialTriggerPriceOrderRequest;
  trigger: Trigger;
  order_type?: string;
}

export interface SignRequestOptions {
  method: string;
  urlPath: string;
  queryString: string;
  payload?: string;
}
export interface WebSocketMessage {
  time: number;
  channel: string;
  event: string;
  payload?: any[];
  auth?: Record<string, string>;
}

export interface OkxOrder {
  instId: string;
  tdMode: string;
  clOrdId?: string;
  tag?: string;
  side: string;
  posSide: string;
  ordType: string;
  sz: string;
  px?: string;
  reduceOnly: boolean;
  attachAlgoOrds?: Array<any>;
  closeOrderAlgo?: Array<any>;
}
export interface OkxCancelOrder {
  instId:string;
  ordId:string;
}

export interface OkxCredentials {
  key: string;
  secret: string;
  passphrase: string;
}
export interface OkxServiceConfig {
  credentials: OkxCredentials;
  baseUrl: string;
}

export interface OkxSignRequestOptions {
  method: string;
  requestPath: string; // e.g., '/api/v5/account/balance?ccy=BTC'
  body?: string | undefined; // JSON string of request body (empty for GET requests)
}

export interface HyperliquidOrder {
  contract: string;           // Asset symbol, e.g., "ETH" or "BTC-USDT"
  position_type: 'long' | 'short';
  market_type: 'market' | 'limit';
  size: number;
  price: string;              // Limit price (send 0 for market orders, logic handles it)
  reduce_only?: boolean;

  // Optional fields for leverage (handled in the Handler before placement)
  leverage?: number;
  leverage_type?: 'CROSS' | 'ISOLATED';

  // Optional TP/SL fields to match your other exchange schemas
  // (Note: Trigger orders require specific 'trigger' logic in the service)
  take_profit?: {
    enabled: boolean;
    price: number;
    price_type?: string; // e.g., 'mark' or 'last'
  };
  stop_loss?: {
    enabled: boolean;
    price: number;
    price_type?: string;
  };
}

export interface HyperliquidCancelOrder {
  contract: string;
  order_id: number; // Hyperliquid OIDs are numbers
}

export interface HyperliquidServiceConfig {
  privateKey: string; // The raw private key (decrypted)
  baseUrl?: string;   // Optional, defaults to mainnet
}

export interface TokocryptoOrder {
  contract: string;
  position_type: 'long' | 'short';
  market_type: 'market' | 'limit';
  size: number;
  price?: number;
  reduce_only?: boolean;
  take_profit?: {
    enabled: boolean;
    price: number;
    price_type?: string;
  };
  stop_loss?: {
    enabled: boolean;
    price: number;
    price_type?: string;
  };
}

export interface TokocryptoCancelOrder {
  instId: string;
  ordId: string;
}

export interface TokocryptoCredentials {
  key: string;
  secret: string;
}

export interface TokocryptoServiceConfig {
  credentials: TokocryptoCredentials | null;
  baseUrl: string;
}
