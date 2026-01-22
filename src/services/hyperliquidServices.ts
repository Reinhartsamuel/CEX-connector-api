import { ExchangeClient, InfoClient, HttpTransport } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";
import { HyperliquidOrder } from "../schemas/interfaces";

const BASE_URL = "https://api.hyperliquid.xyz";

export const HyperliquidServices = {
  exchangeClient: null as ExchangeClient | null,
  account: null as PrivateKeyAccount | null,
  infoClient: new InfoClient({
    transport: new HttpTransport({ apiUrl: BASE_URL }),
  }),

  /**
   * Initialize with the decrypted AGENT Private Key.
   */
  initialize: function (agentPrivateKey: string) {
    const formattedKey = agentPrivateKey.startsWith("0x")
      ? (agentPrivateKey as `0x${string}`)
      : (`0x${agentPrivateKey}` as `0x${string}`);

    const account = privateKeyToAccount(formattedKey);
    this.account = account;

    this.exchangeClient = new ExchangeClient({
      wallet: account,
      transport: new HttpTransport({ apiUrl: BASE_URL }),
    });
  },

  /**
   * Clear active client from memory.
   */
  clearCredentials: function () {
    this.exchangeClient = null;
    this.account = null;
  },

  /**
   * Internal Helper: Maps Symbol (ETH) to Asset ID (4).
   */
  getAssetId: async function (symbol: string): Promise<number> {
    const meta = await this.infoClient.meta();
    const cleanSymbol = symbol.replace("-USDT", "").replace("_USDT", "");
    const asset = meta.universe.find((a) => a.name === cleanSymbol);
    if (!asset) throw new Error(`Asset ${cleanSymbol} not found`);
    return meta.universe.indexOf(asset);
  },

  /**
   * Update Leverage for an asset.
   */
  updateLeverage: async function (
    symbol: string,
    leverage: number,
    isCross: boolean,
  ) {
    if (!this.exchangeClient) throw new Error("Client not initialized");
    const assetId = await this.getAssetId(symbol);

    return await this.exchangeClient.updateLeverage({
      asset: assetId,
      isCross: isCross,
      leverage: leverage,
    });
  },

  /**
   * Place an order (Limit or Market).
   * Markets are executed as aggressive IOC Limit orders using 'FrontendMarket'.
   */
  placeOrder: async function (payload: HyperliquidOrder) {
    if (!this.exchangeClient) throw new Error("Client not initialized");
    const assetId = await this.getAssetId(payload.contract);
    const isBuy = payload.position_type === "long";

    let tif: "Gtc" | "Ioc" | "Alo" | "FrontendMarket" = "Gtc";
    let price = String(payload.price);

    if (payload.market_type === "market") {
      tif = "FrontendMarket";
    }

    return await this.exchangeClient.order({
      orders: [
        {
          a: assetId,
          b: isBuy,
          p: price,
          s: String(payload.size),
          r: payload.reduce_only || false,
          t: {
            limit: {
              tif: tif as any, // Cast due to SDK's internal type string unions
            },
          },
        },
      ],
      grouping: "na",
    });
  },

  /**
   * Cancel an order by OID.
   */
  cancelOrder: async function (symbol: string, orderId: number) {
    if (!this.exchangeClient) throw new Error("Client not initialized");
    const assetId = await this.getAssetId(symbol);

    return await this.exchangeClient.cancel({
      cancels: [{ a: assetId, o: orderId }],
    });
  },

  /**
   * Generic Request Handler for Playground.
   */
  whitelistedRequest: async function ({
    requestPath,
    payloadString,
  }: {
    method: string;
    requestPath: string;
    payloadString: string | undefined;
  }) {
    const isExchange = requestPath.includes("/exchange");
    const body = payloadString ? JSON.parse(payloadString) : {};

    try {
      if (isExchange) {
        if (!this.exchangeClient)
          throw new Error("Credentials not initialized");

        // Map raw action types to SDK signed methods
        switch (body.type) {
          case "order":
            return await this.exchangeClient.order(body);
          case "cancel":
            return await this.exchangeClient.cancel(body);
          case "updateLeverage":
            return await this.exchangeClient.updateLeverage(body);
          default:
            throw new Error(
              `Direct action type '${body.type}' not mapped in whitelistedRequest`,
            );
        }
      } else {
        // Direct fetch for /info allows absolute flexibility for playground testing
        const response = await fetch(`${BASE_URL}/info`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        console.log(response, "response");

        if (!response.ok) {
          return {
            status: "error",
            message: await response.text(),
            statusCode: response.status,
          };
        }
        return await response.json();
      }
    } catch (e: any) {
      return {
        status: "error",
        message: e.message || "Request Failed",
        statusCode: 500,
      };
    }
  },
  formatHyperliquidPrice: function (price: number, szDecimals: number): string {
    // 1. Calculate max allowed decimals: 6 - szDecimals
    const maxDecimals = 6 - szDecimals;

    // 2. Limit to 5 significant figures
    // toPrecision(5) returns a string like "0.12345" or "123.45"
    let formattedPrice = price.toPrecision(5);

    // 3. Ensure we don't exceed the decimal places rule
    const numericPrice = parseFloat(formattedPrice);
    const priceParts = formattedPrice.split(".");

    if (priceParts.length > 1 && priceParts[1].length > maxDecimals) {
      return numericPrice.toFixed(maxDecimals);
    }

    return numericPrice.toString();
  },

  formatHyperliquidSize: function (size: number, szDecimals: number): string {
    // Round to the allowed decimals (e.g., 0 for DOGE, 5 for BTC)
    // We use toFixed which returns a string
    return size.toFixed(szDecimals);
  },

  getAssetMetadata: async function (symbol: string) {
    const meta = await this.infoClient.meta();
    const cleanSymbol = symbol.replace("-USDT", "").replace("_USDT", "");
    const assetIndex = meta.universe.findIndex((a) => a.name === cleanSymbol);
    const assetMeta = meta.universe[assetIndex];

    if (!assetMeta) throw new Error(`Asset ${cleanSymbol} not found`);

    return {
      index: assetIndex,
      szDecimals: assetMeta.szDecimals,
      name: assetMeta.name,
    };
  },
};
