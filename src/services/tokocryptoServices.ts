import ccxt from 'ccxt';
import type { TokocryptoOrder } from '../schemas/interfaces';
import * as JSONbig from "json-bigint";

export const TokocryptoServices = {
  exchange: null as ccxt.tokocrypto | null,

  initialize: function(apiKey: string, apiSecret: string, marketType: 'spot' | 'future' = 'future') {
    this.exchange = new ccxt.tokocrypto({
      apiKey: apiKey,
      secret: apiSecret,
      enableRateLimit: true,
      options: {
        defaultType: marketType, // 'spot' or 'future'
      }
    });
  },

  clearCredentials: function() {
    this.exchange = null;
  },

  // Update position mode (Binance/Tokocrypto futures)
  // positionMode: 'true' = hedge mode (dual position), 'false' = one-way mode
  updatePositionMode: async function(hedgeMode: boolean) {
    if (!this.exchange) throw new Error("Exchange not initialized");

    try {
      // Binance/Tokocrypto specific: dualSidePosition parameter
      // true = hedge mode (can hold long and short simultaneously)
      // false = one-way mode (only one direction at a time)
      const result = await this.exchange.fapiPrivatePostPositionsideDual({
        dualSidePosition: hedgeMode ? 'true' : 'false'
      });
      return result;
    } catch (error: any) {
      console.error("Error setting position mode:", error.message);
      return {
        status: "error",
        message: error.message,
        statusCode: error.statusCode || 500,
      };
    }
  },

  // Update leverage (futures only)
  // Tokocrypto/Binance: leverage is set per symbol
  updateLeverage: async function(symbol: string, leverage: number) {
    if (!this.exchange) throw new Error("Exchange not initialized");

    try {
      // CCXT unified method for setting leverage
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

  // Update margin mode (futures only)
  // marginMode: 'ISOLATED' or 'CROSS'
  updateMarginMode: async function(symbol: string, marginMode: 'ISOLATED' | 'CROSS') {
    if (!this.exchange) throw new Error("Exchange not initialized");

    try {
      // Binance/Tokocrypto specific: setMarginMode
      const result = await this.exchange.setMarginMode(marginMode, symbol);
      return result;
    } catch (error: any) {
      console.error("Error setting margin mode:", error.message);
      return {
        status: "error",
        message: error.message,
        statusCode: error.statusCode || 500,
      };
    }
  },

  // Place order using CCXT unified API
  placeOrder: async function(payload: TokocryptoOrder) {
    if (!this.exchange) throw new Error("Exchange not initialized");

    try {
      const side = payload.position_type === 'long' ? 'buy' : 'sell';
      const type = payload.market_type;

      const params: any = {
        reduceOnly: payload.reduce_only || false,
      };

      // Add TP/SL if enabled (futures only)
      if (payload.take_profit?.enabled && payload.take_profit.price) {
        params.takeProfit = {
          triggerPrice: payload.take_profit.price,
          price: payload.take_profit.price,
        };
      }

      if (payload.stop_loss?.enabled && payload.stop_loss.price) {
        params.stopLoss = {
          triggerPrice: payload.stop_loss.price,
          price: payload.stop_loss.price,
        };
      }

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

  // Whitelist request for testing/playground
  whitelistedRequest: async function(options: { method: string; endpoint: string; params?: any }) {
    if (!this.exchange) throw new Error("Exchange not initialized");

    try {
      const { method, endpoint, params } = options;

      // Use CCXT's publicRequest or privateRequest methods
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
      'closed': 'waiting_targets', // Position opened
      'canceled': 'cancelled',
      'expired': 'cancelled',
      'rejected': 'failed',
    };

    return statusMap[ccxtStatus] || 'unknown';
  },
};
