import { password } from "bun";
import { OkxOrder, OkxServiceConfig } from "../schemas/interfaces";
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
        body: payload,
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


  whitelistedRequest: async function ({
    method,
    requestPath,
    payload,
  }: {
    method: string;
    requestPath: string;
    payload: any;
  }) {
    console.log(this.config.credentials, 'thisconfigcredentials')
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
      body: payload ? JSON.stringify(payload) : "",
    });
    const response = await fetch(this.config.baseUrl + requestPath, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: payload ? JSON.stringify(payload) : "",
      verbose:true
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
