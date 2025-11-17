import {
  GateFuturesOrder,
  GateServiceConfig,
  GateTriggerPriceOrder,
} from "../schemas/interfaces";
import { signRequest } from "../utils/signRequest";
import * as z from "zod";
import { closeFuturesPositionSchema } from "../schemas/gateSchemas";
import * as JSONbig from "json-bigint";

export const GateServices = {
  initialize: function (apiKey: string, secretKey: string) {
    this.config.credentials = {
      key: apiKey!,
      secret: secretKey!,
    };
  },
  config: {
    baseUrl: "https://api.gateio.ws",
  } as GateServiceConfig,
  /**
   * Update margin mode for a futures position
   * @param contract - The contract symbol (e.g., "BTC_USDT")
   * @param marginMode - The margin mode: "cross" or "isolated"
   */
  updateMarginMode: async function (
    contract: string,
    marginMode: "ISOLATED" | "CROSS",
  ) {
    if (!this.config.credentials) {
      throw new Error("No credentials found. Call initialize first!");
    }

    const method = "POST";
    const urlPath = "/api/v4/futures/usdt/positions/cross_mode";
    const queryString = "";

    const payload = {
      contract,
      mode: marginMode,
    };
    const payloadStr = JSON.stringify(payload);

    // Generate signed headers
    const headers = signRequest(this.config.credentials, {
      method,
      urlPath,
      queryString,
      payload: payloadStr,
    });

    // Make API request
    const response = await fetch(
      `${this.config.baseUrl}${urlPath}?${queryString}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: payloadStr,
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Gate.io API error on updateMarginMode (${response.status}): ${errorText}`,
      );
    }

    const responseText = await response.text();
    const gateData = JSONbig.parse(responseText);
    return gateData;
  },

  /**
   * Update leverage for a futures position
   * @param contract - The contract symbol (e.g., "BTC_USDT")
   * @param leverage - The leverage value (e.g., 10 for 10x)
   * @param marginMode - The margin mode: "cross" or "isolated"
   */
  updateLeverage: async function (contract: string, leverage: number) {
    if (!this.config.credentials) {
      throw new Error("No credentials found. Call initialize first!");
    }

    const method = "POST";
    const urlPath = `/api/v4/futures/usdt/positions/${contract}/leverage`;
    const queryString = `leverage=${leverage}`;

    // Generate signed headers
    const headers = signRequest(this.config.credentials, {
      method,
      urlPath,
      queryString,
      payload: "",
    });

    // Make API request
    let fullUrl = this.config.baseUrl + urlPath;
    if (queryString) {
      fullUrl += "?" + queryString;
    }
    const response = await fetch(fullUrl, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      verbose: true,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Gate.io API error on updateLeverage (${response.status}): ${errorText}`,
      );
    }

    const responseText = await response.text();
    const gateData = JSONbig.parse(responseText);
    return gateData;
  },

  /**
   * Get current positions to check current margin mode and leverage
   */
  getPositions: async function () {
    if (!this.config.credentials) {
      throw new Error("No credentials found. Call initialize first!");
    }

    const method = "GET";
    const urlPath = "/api/v4/futures/usdt/positions";
    const queryString = "";
    const payload = "";

    // Generate signed headers
    const headers = signRequest(this.config.credentials, {
      method,
      urlPath,
      queryString,
      payload,
    });

    // Make API request
    const response = await fetch(
      `${this.config.baseUrl}${urlPath}?${queryString}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Gate.io API error on getPositions (${response.status}): ${errorText}`,
      );
    }

    const responseText = await response.text();
    return JSONbig.parse(responseText);
  },
  /**
   * Place futures order
   */
  placeFuturesOrder: async function (payload: GateFuturesOrder) {
    if (!this.config.credentials) {
      throw new Error("No credentials found. Call initialize first!");
    }

    const method = "POST";
    const urlPath = "/api/v4/futures/usdt/orders";
    const payloadStr = JSON.stringify(payload);

    // Generate signed headers
    const headers = signRequest(this.config.credentials, {
      method,
      urlPath,
      queryString: "",
      payload: payloadStr,
    });
    console.log(headers, "headers placeorder");
    console.log(`${this.config.baseUrl}${urlPath}`, "url");

    // Make API request
    const response = await fetch(`${this.config.baseUrl}${urlPath}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Gate.io API error on placeFuturesOrder (${response.status}): ${errorText}`,
      );
    }

    const responseText = await response.text();
    return JSONbig.parse(responseText);
  },

  /**
   * Send Trigger Order aka TP/SL
   * @param payload - The payload for the trigger price order.
   */
  triggerPriceOrder: async function (payload: GateTriggerPriceOrder) {
    if (!this.config.credentials) {
      throw new Error("No credentials found. Call initialize first!");
    }

    const method = "POST";
    const urlPath = "/api/v4/futures/usdt/price_orders";
    const payloadStr = JSON.stringify(payload);

    // Generate signed headers
    const headers = signRequest(this.config.credentials, {
      method,
      urlPath,
      queryString: "",
      payload: payloadStr,
    });

    // Make API request
    const response = await fetch(`${this.config.baseUrl}${urlPath}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Gate.io API error on triggerPriceOrder (${response.status}): ${errorText}`,
      );
    }

    const responseText = await response.text();
    return JSONbig.parse(responseText);
  },

  /**
   * Close running futures position
   * @param payload - Close futures position
   */
  closeFuturesOrder: async function (
    payload: z.infer<typeof closeFuturesPositionSchema>,
  ) {
    if (!this.config.credentials) {
      throw new Error("No credentials found. Call initialize first!");
    }
    const data = {
      contract: payload.contract,
      size: 0,
      price: "0",
      tif: "ioc",
      iceberg: 0,
      reduce_only: true,
      auto_size: payload.auto_size,
      settle: "usdt",
      close: false,
    };

    return this.placeFuturesOrder(data as GateFuturesOrder);
  },

  /**
   * Cancel futures order with open status
   * @param orderId - The order ID to cancel
   */
  cancelFuturesOrder: async function (orderId: string) {
    if (!this.config.credentials) {
      throw new Error("No credentials found. Call initialize first!");
    }
    const urlPath = `/api/v4/futures/usdt/orders/${orderId}`;
    const headers = signRequest(this.config.credentials, {
      method: "DELETE",
      urlPath: urlPath,
      queryString: "",
    });
    const response = await fetch(this.config.baseUrl + urlPath, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to cancel order: ${response.statusText}`);
    }

    const responseText = await response.text();
    return JSONbig.parse(responseText);
  },


  /**
   * Cancel price triggered order aka TP/SL
   * @param orderId - The order ID to cancel
   */
  cancelPriceTrigger: async function (orderId: string) {
    if (!this.config.credentials) {
      throw new Error("No credentials found. Call initialize first!");
    }
    const urlPath = `/api/v4/futures/usdt/price_orders/${orderId}`;
    const headers = signRequest(this.config.credentials, {
      method: "DELETE",
      urlPath: urlPath,
      queryString: "",
    });
    const response = await fetch(this.config.baseUrl + urlPath, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to cancel order: ${response.statusText}`);
    }

    const responseText = await response.text();
    return JSONbig.parse(responseText);
  },
  /**
   * Get details of a futures order
   * @param orderId - The order ID to cancel
   */
  getFuturesOrder: async function (orderId: string) {
    if (!this.config.credentials) {
      throw new Error("No credentials found. Call initialize first!");
    }

    const urlPath = `/api/v4/futures/usdt/orders/${orderId}`;
    const headers = signRequest(this.config.credentials, {
      method: "GET",
      urlPath,
      queryString: "",
    });
    const response = await fetch(this.config.baseUrl + urlPath, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Gate.io API error on getFuturesOrder (${response.status}): ${errorText}`,
      );
    }

    const responseText = await response.text();
    return JSONbig.parse(responseText);
  },
};
