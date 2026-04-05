import ccxt from 'ccxt';
import type { BitmartOrder } from '../schemas/interfaces';

export const BitmartServices = {
  exchange: null as ccxt.bitmart | null,

  initialize: function(apiKey: string, apiSecret: string, memo: string) {
    this.exchange = new ccxt.bitmart({
      apiKey: apiKey,
      secret: apiSecret,
      uid: memo, // BitMart requires memo/uid as the passphrase equivalent
      enableRateLimit: true,
      options: {
        defaultType: 'swap',
        brokerId: process.env.BITMART_BROKER_ID ?? '',
      }
    });
  },

  clearCredentials: function() {
    this.exchange = null;
  },

  // Update leverage (futures only)
  updateLeverage: async function(symbol: string, leverage: number) {
    if (!this.exchange) throw new Error("Exchange not initialized");

    try {
      return await this.exchange.setLeverage(leverage, symbol);
    } catch (error: any) {
      console.error("Error setting leverage:", error.message);
      return {
        status: "error",
        message: error.message,
        statusCode: error.statusCode || 500,
      };
    }
  },

  // Note: BitMart does NOT support setMarginMode - skip this call

  // Place order using CCXT unified API
  placeOrder: async function(payload: BitmartOrder) {
    if (!this.exchange) throw new Error("Exchange not initialized");

    try {
      const side = payload.position_type === 'long' ? 'buy' : 'sell';
      const type = payload.market_type;

      const params: any = {
        reduceOnly: payload.reduce_only || false,
      };

      const order = await this.exchange.createOrder(
        payload.contract,
        type,
        side,
        payload.size,
        type === 'limit' ? payload.price : undefined,
        params
      );

      return order;
    } catch (error: any) {
      console.error("Error placing order:", error.message);
      throw error;
    }
  },

  // Cancel order
  cancelOrder: async function(orderId: string, symbol: string) {
    if (!this.exchange) throw new Error("Exchange not initialized");

    try {
      return await this.exchange.cancelOrder(orderId, symbol);
    } catch (error: any) {
      console.error("Error canceling order:", error.message);
      return {
        status: "error",
        message: error.message,
        statusCode: error.statusCode || 500,
      };
    }
  },

  // Fetch account balance
  fetchBalance: async function() {
    if (!this.exchange) throw new Error("Exchange not initialized");

    try {
      return await this.exchange.fetchBalance();
    } catch (error: any) {
      console.error("Error fetching balance:", error.message);
      return {
        status: "error",
        message: error.message,
        statusCode: error.statusCode || 500,
      };
    }
  },

  // Whitelisted request for testing/playground
  whitelistedRequest: async function(options: { method: string; endpoint: string; params?: any }) {
    if (!this.exchange) throw new Error("Exchange not initialized");

    try {
      const { method, endpoint, params } = options;

      if (method === 'GET') {
        return await this.exchange.fetch(endpoint, params);
      } else if (method === 'POST') {
        return await this.exchange.fetch(endpoint, method, undefined, params);
      }

      throw new Error(`Unsupported method: ${method}`);
    } catch (error: any) {
      console.error("Error in whitelisted request:", error.message);
      return {
        status: "error",
        message: error.message,
        statusCode: error.statusCode || 500,
      };
    }
  },

  // Map CCXT status to DB status
  mapCcxtStatusToDb: function(ccxtStatus: string, marketType: string): string {
    const statusMap: Record<string, any> = {
      'open': marketType === 'market' ? 'waiting_position' : 'waiting_position',
      'closed': 'waiting_targets',
      'canceled': 'cancelled',
      'expired': 'cancelled',
      'rejected': 'failed',
    };

    return statusMap[ccxtStatus] || 'unknown';
  },
};