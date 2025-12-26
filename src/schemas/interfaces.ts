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
  reduceOnly: false;
  attachAlgoOrds?: Array<any>;
  closeOrderAlgo?: Array<any>;
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
  body?: any; // JSON string of request body (empty for GET requests)
}
