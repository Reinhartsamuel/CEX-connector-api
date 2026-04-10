import { OkxCancelOrder, OkxOrder, OkxServiceConfig } from "../schemas/interfaces";
import { signRequestOkx } from "../utils/authentication/signRequestOkx";
import * as JSONbig from "json-bigint";

export const OkxServices = {
  initialize: function (apiKey: string, secretKey: string, passphrase: string) {
    this.config.credentials = {
      key: apiKey!,
      secret: secretKey!,
      passphrase:passphrase!
    };
  },
  config: {
    baseUrl: "https://www.okx.com",
  } as OkxServiceConfig,

  clearCredentials: function () {
    this.config.credentials = {
      key:'',
      secret:'',
      passphrase : ''
    }
  },

  placeOrder: async function (payload: OkxOrder) {
    const requestPath = "/api/v5/trade/order";
    const headers = signRequestOkx(
      {
        key: this.config.credentials.key,
        secret: this.config.credentials.secret,
        passphrase: this.config.credentials.passphrase,
      },
      {
        method: "POST",
        requestPath: requestPath,
        body: JSON.stringify(payload),
      },
    );

    const response = await fetch(this.config.baseUrl + requestPath, {
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        status: "error",
        message: errorText,
        statusCode: response.status,
      };
    }
    const responseText = await response.text();
    return JSONbig.parse(responseText);
  },

  cancelOrder : async function (payload:OkxCancelOrder) {
    const requestPath = "/api/v5/trade/cancel-order";
    const headers = signRequestOkx(
      {
        key: this.config.credentials.key,
        secret: this.config.credentials.secret,
        passphrase: this.config.credentials.passphrase,
      },
      {
        method: "POST",
        requestPath: requestPath,
        body: JSON.stringify(payload),
      },
    );

    const response = await fetch(this.config.baseUrl + requestPath, {
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        status: "error",
        message: errorText,
        statusCode: response.status,
      };
    }
    const responseText = await response.text();
    return JSONbig.parse(responseText);
  },

  /**
   * Get order details by orderId
   * GET /api/v5/trade/order?instId=...&ordId=...
   */
  getOrderDetails: async function (instId: string, ordId: string) {
    const requestPath = `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`;
    const headers = signRequestOkx(
      {
        key: this.config.credentials.key,
        secret: this.config.credentials.secret,
        passphrase: this.config.credentials.passphrase,
      },
      {
        method: "GET",
        requestPath,
      },
    );

    const response = await fetch(this.config.baseUrl + requestPath, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { status: "error", message: errorText, statusCode: response.status };
    }
    const responseText = await response.text();
    return JSONbig.parse(responseText);
  },

  /**
   * Get pending orders (open/partially filled)
   * GET /api/v5/trade/orders-pending?instType=SWAP
   */
  getPendingOrders: async function (instType: string = "SWAP") {
    const requestPath = `/api/v5/trade/orders-pending?instType=${instType}`;
    const headers = signRequestOkx(
      {
        key: this.config.credentials.key,
        secret: this.config.credentials.secret,
        passphrase: this.config.credentials.passphrase,
      },
      {
        method: "GET",
        requestPath,
      },
    );

    const response = await fetch(this.config.baseUrl + requestPath, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { status: "error", message: errorText, statusCode: response.status };
    }
    const responseText = await response.text();
    return JSONbig.parse(responseText);
  },

  /**
   * Get current positions
   * GET /api/v5/account/positions?instType=SWAP
   */
  getPositions: async function (instType: string = "SWAP") {
    const requestPath = `/api/v5/account/positions?instType=${instType}`;
    const headers = signRequestOkx(
      {
        key: this.config.credentials.key,
        secret: this.config.credentials.secret,
        passphrase: this.config.credentials.passphrase,
      },
      {
        method: "GET",
        requestPath,
      },
    );

    const response = await fetch(this.config.baseUrl + requestPath, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { status: "error", message: errorText, statusCode: response.status };
    }
    const responseText = await response.text();
    return JSONbig.parse(responseText);
  },

  /**
   * Get instrument details by instId (e.g., "BTC-USDT-SWAP" or "BTC-USDT")
   * Returns ctVal, ctMult, ctValCcy, instType, and other metadata
   * GET /api/v5/public/instruments?instType=...&instId=...
   */
  getInstrument: async function (instId: string): Promise<{
    status: 'success' | 'error';
    data?: {
      instId: string;
      instType: string; // 'SPOT' | 'SWAP' | 'FUTURES' | 'OPTION'
      ctVal?: string; // contract value (futures/swap)
      ctMult?: string; // contract multiplier (futures/swap)
      ctValCcy?: string; // contract value currency
      lotSz?: string; // base asset increment (spot)
      tickSz?: string; // quote asset increment
    };
    message?: string;
    statusCode?: number;
  }> {
    // Determine instType from instId format
    let instType = 'SPOT';
    if (instId.endsWith('-SWAP') || instId.endsWith('-FUTURES')) {
      instType = instId.includes('SWAP') ? 'SWAP' : 'FUTURES';
    } else if (instId.includes('-')) {
      // Likely spot format like BTC-USDT
      instType = 'SPOT';
    }

    const requestPath = `/api/v5/public/instruments?instType=${instType}${instId ? `&instId=${encodeURIComponent(instId)}` : ''}`;
    
    const headers = signRequestOkx(
      {
        key: this.config.credentials.key,
        secret: this.config.credentials.secret,
        passphrase: this.config.credentials.passphrase,
      },
      {
        method: "GET",
        requestPath,
      },
    );

    const response = await fetch(this.config.baseUrl + requestPath, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        status: "error",
        message: errorText,
        statusCode: response.status,
      };
    }

    const responseText = await response.text();
    const parsed = JSONbig.parse(responseText);
    
    // OKX returns { code: '0', data: [...] } on success
    if (parsed.code === '0' && Array.isArray(parsed.data) && parsed.data.length > 0) {
      const instrument = parsed.data[0];
      return {
        status: 'success',
        data: {
          instId: instrument.instId,
          instType: instrument.instType,
          ctVal: instrument.ctVal,
          ctMult: instrument.ctMult,
          ctValCcy: instrument.ctValCcy,
          lotSz: instrument.lotSz,
          tickSz: instrument.tickSz,
        },
      };
    }
    
    return {
      status: 'error',
      message: 'Instrument not found',
      statusCode: 404,
    };
  },

  /**
   * List all available SWAP instruments with their multipliers
   * GET /api/v5/public/instruments?instType=SWAP
   */
  listInstruments: async function (instType: string = "SWAP"): Promise<{
    status: 'success' | 'error';
    data?: Array<{
      instId: string;
      instType: string;
      ctVal?: string;
      ctMult?: string;
      ctValCcy?: string;
      lotSz?: string;
      tickSz?: string;
    }>;
    message?: string;
    statusCode?: number;
  }> {
    const requestPath = `/api/v5/public/instruments?instType=${instType}`;
    
    const headers = signRequestOkx(
      {
        key: this.config.credentials.key,
        secret: this.config.credentials.secret,
        passphrase: this.config.credentials.passphrase,
      },
      {
        method: "GET",
        requestPath,
      },
    );

    const response = await fetch(this.config.baseUrl + requestPath, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        status: "error",
        message: errorText,
        statusCode: response.status,
      };
    }

    const responseText = await response.text();
    const parsed = JSONbig.parse(responseText);
    
    if (parsed.code === '0' && Array.isArray(parsed.data)) {
      return {
        status: 'success',
        data: parsed.data.map((instrument: any) => ({
          instId: instrument.instId,
          instType: instrument.instType,
          ctVal: instrument.ctVal,
          ctMult: instrument.ctMult,
          ctValCcy: instrument.ctValCcy,
          lotSz: instrument.lotSz,
          tickSz: instrument.tickSz,
        })),
      };
    }
    
    return {
      status: 'error',
      message: 'Failed to retrieve instruments',
      statusCode: response.status,
    };
  },

  whitelistedRequest: async function ({
    method,
    requestPath,
    payloadString,
  }: {
    method: string;
    requestPath: string;
    payloadString: string | undefined;
  }) {
    if (
      !this.config.credentials ||
      !this.config.credentials.key ||
      !this.config.credentials.secret ||
      !this.config.credentials.passphrase
    ) {
      throw new Error("Missing or invalid credentials, call initialize first!");
    }

    const headers = signRequestOkx(this.config.credentials, {
      method,
      requestPath,
      body: payloadString ? payloadString : "",
    });
    const response = await fetch(this.config.baseUrl + requestPath, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: payloadString ? payloadString : "",
      verbose:true,
      tls: {
            rejectUnauthorized: false,
          },
    });
    if (!response.ok) {
      const errorText = await response.text();
      return {
        status: "error",
        message: errorText,
        statusCode: response.status,
      };
    }

    const responseText = await response.text();
    return JSONbig.parse(responseText);
  },
};