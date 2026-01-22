/* eslint-disable @typescript-eslint/no-explicit-any */
import { Context } from "hono";
import { TokocryptoServices } from "../../services/tokocryptoServices";
import type { TokocryptoOrder } from "../../schemas/interfaces";
import * as z from "zod";
import Redis from "ioredis";
import { postgresDb } from "../../db/client";
import { exchanges, trades } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import * as JSONbig from "json-bigint";
import redis from "../../db/redis";
import {
  decrypt,
  generateAndEncryptCredentials,
  kmsClient,
} from "../../utils/cryptography/kmsUtils";
import { DecryptCommand } from "@aws-sdk/client-kms";
import {
  tokocryptoRegisterUserSchema,
  tokocryptoPlaceOrderSchema,
  tokocryptoCancelOrderSchema,
  tokocryptoClosePositionSchema,
} from "../../schemas/tokocryptoSchemas";

export const TokocryptoHandler = {
  /**
    Unwraps and decrypts the credentials for a given exchange ID.
  */
  unwrapCredentials: async function (exchangeId: number): Promise<{
    api_key: string;
    api_secret: string;
    user_id: number;
    encrypted_api_key: string;
    encrypted_api_secret: string;
    exchange_user_id: string;
  }> {
    const exchange = await postgresDb.query.exchanges.findFirst({
      where: eq(exchanges.id, exchangeId),
    });
    if (!exchange) throw new Error("exchange not found");

    const dekResp = await kmsClient.send(
      new DecryptCommand({
        CiphertextBlob: exchange.enc_dek!,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      }),
    );
    if (!dekResp.Plaintext) throw new Error("KMS decrypt failed");

    const plaintextDEK = Buffer.from(dekResp.Plaintext);

    const decryptedApiKey = decrypt(
      JSON.parse(exchange.api_key_encrypted),
      plaintextDEK,
    );
    const decryptedApiSecret = decrypt(
      JSON.parse(exchange.api_secret_encrypted),
      plaintextDEK,
    );

    // Zero out DEK from memory
    plaintextDEK.fill(0);

    return {
      api_key: decryptedApiKey,
      api_secret: decryptedApiSecret,
      user_id: exchange.user_id,
      encrypted_api_key: exchange.api_key_encrypted,
      encrypted_api_secret: exchange.api_secret_encrypted,
      exchange_user_id: exchange.exchange_user_id,
    };
  },

  registerUser: async function (c: Context) {
    try {
      const body = (await c.req.json()) as z.infer<
        typeof tokocryptoRegisterUserSchema
      >;
      let { api_key, api_secret, user_id } = body;

      // Initialize CCXT with credentials
      TokocryptoServices.initialize(api_key, api_secret, 'future');

      // Check if exchange already registered
      const existing = await postgresDb.query.exchanges.findFirst({
        where: and(
          eq(exchanges.exchange_title, "tokocrypto"),
          eq(exchanges.user_id, user_id),
        ),
      });

      if (existing?.id)
        return c.json(
          {
            message: "ERROR!",
            error: `exchange already registered for 'tokocrypto' user_id ${user_id} with exchange id ${existing.id}`,
          },
          { status: 400 },
        );

      // Validate credentials by fetching account balance
      const balance = await TokocryptoServices.fetchBalance();

      // Clear credentials from service
      TokocryptoServices.clearCredentials();

      if (balance.status === "error")
        return c.json(
          {
            ...balance,
          },
          { status: balance.statusCode },
        );

      // Extract user ID from balance info (Tokocrypto uses Binance structure)
      const accountInfo = balance.info || {};
      const tokocryptoUserId = accountInfo.uid || `toko_${user_id}`;

      // Encrypt credentials using KMS
      const {
        encryptedDEK,
        apiKey: encryptedApiKey,
        apiSecret: encryptedApiSecret,
      } = await generateAndEncryptCredentials(
        api_key,
        api_secret,
      );

      // Clear plaintext credentials from memory
      api_key = '';
      api_secret = '';

      // Serialize encrypted payloads for DB
      const apiKeyCiphertext = JSON.stringify(encryptedApiKey);
      const apiSecretCiphertext = JSON.stringify(encryptedApiSecret);

      // Insert into database
      const exchangeRecord = await postgresDb
        .insert(exchanges)
        .values({
          user_id,
          exchange_title: "tokocrypto",
          exchange_user_id: tokocryptoUserId,
          market_type: "futures",
          api_key_encrypted: apiKeyCiphertext,
          api_secret_encrypted: apiSecretCiphertext,
          enc_dek: encryptedDEK,
        })
        .returning({
          exchange_id: exchanges.id,
          user: exchanges.user_id,
        });

      return c.json({
        message: "ok",
        balance,
        exchangeRecord,
      });
    } catch (e) {
      console.error(e, "ERROR 500 REGISTER USER tokocryptoServices");
      if (e instanceof Error) {
        return c.json(
          {
            message: "ERROR!",
            error: e.message,
          },
          { status: 500 },
        );
      }
      return c.json(
        {
          message: "ERROR!",
          error: "UNKNOWN ERROR",
        },
        { status: 500 },
      );
    }
  },

  order: async function (c: Context) {
    try {
      const body = await c.req.json() as z.infer<typeof tokocryptoPlaceOrderSchema>;

      // Unwrap credentials
      let {
        api_key,
        api_secret,
        user_id,
        exchange_user_id
      } = await TokocryptoHandler.unwrapCredentials(body.exchange_id);

      // Initialize CCXT service
      TokocryptoServices.initialize(api_key, api_secret, body.market);

      // Clear credentials from memory immediately
      api_key = '';
      api_secret = '';

      const allReturn: { message: string; data: any } = {
        message: "ok",
        data: {},
      };

      // Update position mode, leverage, and margin mode (futures only)
      if (body.market === 'futures') {
        // 1. Set position mode (hedge mode = true allows simultaneous long/short)
        const hedgeMode = (body.position_mode || 'hedge') === 'hedge';
        const resPositionMode = await TokocryptoServices.updatePositionMode(hedgeMode);
        allReturn.data.resPositionMode = resPositionMode;

        // 2. Set leverage for the symbol
        const resLeverage = await TokocryptoServices.updateLeverage(
          body.contract,
          body.leverage
        );
        allReturn.data.resLeverage = resLeverage;

        // 3. Set margin mode (ISOLATED or CROSS)
        const resMarginMode = await TokocryptoServices.updateMarginMode(
          body.contract,
          body.leverage_type
        );
        allReturn.data.resMarginMode = resMarginMode;
      }

      // Build order payload
      const orderPayload: TokocryptoOrder = {
        contract: body.contract,
        position_type: body.position_type,
        market_type: body.market_type,
        size: body.size,
        price: body.price,
        reduce_only: body.reduce_only,
        take_profit: body.take_profit,
        stop_loss: body.stop_loss,
      };

      // Place order via CCXT
      const ccxtOrder = await TokocryptoServices.placeOrder(orderPayload);
      allReturn.data.ccxtOrder = ccxtOrder;

      // Map CCXT status to DB status
      const tradeStatus = TokocryptoServices.mapCcxtStatusToDb(
        ccxtOrder.status,
        body.market_type
      );

      // Build trade record
      const addData = {
        user_id: user_id,
        exchange_id: body.exchange_id,
        autotrader_id: body.autotrader_id,
        trade_id: String(ccxtOrder.id),
        order_id: String(ccxtOrder.id),
        open_order_id: String(ccxtOrder.id),
        contract: body.contract,
        position_type: body.position_type,
        market_type: body.market_type,
        size: String(ccxtOrder.amount),
        price: String(ccxtOrder.price || body.price || 0),
        leverage: body.leverage,
        leverage_type: body.leverage_type,
        status: tradeStatus,
        reduce_only: body.reduce_only,
        is_tpsl: false,

        // Take profit tracking
        take_profit_enabled: body.take_profit.enabled,
        take_profit_executed: body.take_profit.enabled && ccxtOrder.status === 'closed',
        take_profit_price: body.take_profit.enabled ? String(body.take_profit.price) : null,
        take_profit_price_type: body.take_profit.enabled ? body.take_profit.price_type : null,

        // Stop loss tracking
        stop_loss_enabled: body.stop_loss.enabled,
        stop_loss_executed: body.stop_loss.enabled && ccxtOrder.status === 'closed',
        stop_loss_price: body.stop_loss.enabled ? String(body.stop_loss.price) : null,
        stop_loss_price_type: body.stop_loss.enabled ? body.stop_loss.price_type : null,

        // Store full CCXT response as metadata
        metadata: JSON.parse(JSONbig.stringify(ccxtOrder)),
      };

      // Insert trade record
      const newTrade = await postgresDb
        .insert(trades)
        .values(addData as any)
        .returning();

      allReturn.data.newTrade = newTrade;

      // Publish WebSocket control message
      await redis.publish(
        "ws-control",
        JSON.stringify({
          op: "open",
          userId: String(exchange_user_id),
          contract: body.contract,
        }),
      );

      // Clear CCXT credentials
      TokocryptoServices.clearCredentials();

      return c.json(allReturn);
    } catch (e) {
      console.error(e, "ERROR 500 ORDER tokocryptoServices");

      // Clear credentials on error
      TokocryptoServices.clearCredentials();

      if (e instanceof Error) {
        return c.json(
          {
            message: "ERROR!",
            error: e.message,
          },
          { status: 500 },
        );
      }
      return c.json(
        {
          message: "ERROR!",
          error: "UNKNOWN ERROR",
        },
        { status: 500 },
      );
    }
  },

  cancelOrder: async function (c: Context) {
    try {
      const body = await c.req.json() as z.infer<typeof tokocryptoCancelOrderSchema>;

      let { api_key, api_secret, user_id } =
        await TokocryptoHandler.unwrapCredentials(body.exchange_id);

      TokocryptoServices.initialize(api_key, api_secret);
      api_key = '';
      api_secret = '';

      // Find all trades for autotrader + contract
      const foundTrades = await postgresDb.query.trades.findMany({
        where: and(
          eq(trades.autotrader_id, body.autotrader_id),
          eq(trades.contract, body.contract)
        ),
      });

      // Cancel all orders using Promise.allSettled
      const results = await Promise.allSettled(
        foundTrades.map(async (trade) => {
          const resultCancel = await TokocryptoServices.cancelOrder(
            trade.order_id,
            trade.contract
          );
          return { ...resultCancel, id: trade.id };
        })
      );

      // Update database for successful cancellations
      await Promise.allSettled(
        results.map(async (result) => {
          if (result?.status === 'fulfilled' && result?.value?.status !== 'error') {
            await postgresDb
              .update(trades)
              .set({ status: 'cancelled' })
              .where(eq(trades.id, result.value.id));
          } else {
            console.log(`Cancelling status: ${result.status} failed!!!`);
          }
        })
      );

      TokocryptoServices.clearCredentials();

      return c.json(results);
    } catch (e) {
      console.error(e, "ERROR 500 CANCEL ORDER tokocryptoServices");
      TokocryptoServices.clearCredentials();

      if (e instanceof Error) {
        return c.json(
          {
            message: "ERROR!",
            error: e.message,
          },
          { status: 500 },
        );
      }
      return c.json(
        {
          message: "ERROR!",
          error: "UNKNOWN ERROR",
        },
        { status: 500 },
      );
    }
  },

  closePositionDb: async function (c: Context) {
    try {
      const body = await c.req.json() as z.infer<typeof tokocryptoClosePositionSchema>;

      const { api_key, api_secret, user_id } =
        await TokocryptoHandler.unwrapCredentials(body.exchange_id);

      TokocryptoServices.initialize(api_key, api_secret);

      // Find all running trades for this contract
      const running_trades = await postgresDb.query.trades.findMany({
        where: and(
          eq(trades.exchange_id, body.exchange_id),
          eq(trades.contract, body.contract),
          eq(trades.status, "waiting_targets"),
        ),
      });

      // Close all running trades with reverse orders
      const closed_trades = await Promise.all(
        running_trades.map(async (trade) => {
          // Create reverse order to close position
          const closePayload: TokocryptoOrder = {
            contract: trade.contract,
            position_type: trade.position_type === 'long' ? 'short' : 'long', // Opposite direction
            market_type: 'market',
            size: Math.abs(parseFloat(trade.size)),
            reduce_only: true,
          };

          const ccxtOrder = await TokocryptoServices.placeOrder(closePayload);

          // Update trade record if close order filled
          if (ccxtOrder.status === 'closed' && ccxtOrder.filled === ccxtOrder.amount) {
            const pnl = ccxtOrder.fee ? ccxtOrder.cost - ccxtOrder.fee.cost : ccxtOrder.cost;

            await postgresDb
              .update(trades)
              .set({
                status: "closed",
                close_order_id: String(ccxtOrder.id),
                pnl: String(pnl),
                closed_at: new Date(),
              })
              .where(eq(trades.id, trade.id));
          }

          return ccxtOrder;
        }),
      );

      TokocryptoServices.clearCredentials();

      return c.json({
        running_trades,
        user_id,
        closed_trades,
      });
    } catch (e) {
      console.error(e, "ERROR 500 CLOSE POSITION tokocryptoServices");
      TokocryptoServices.clearCredentials();

      if (e instanceof Error) {
        return c.json(
          {
            message: "ERROR!",
            error: e.message,
          },
          { status: 500 },
        );
      }
      return c.json(
        {
          message: "ERROR!",
          error: "UNKNOWN ERROR",
        },
        { status: 500 },
      );
    }
  },

  playground: async function (c: Context) {
    try {
      const body = await c.req.json();
      const { exchange_id, method, endpoint, params } = body;

      const { api_key, api_secret } =
        await TokocryptoHandler.unwrapCredentials(exchange_id);

      TokocryptoServices.initialize(api_key, api_secret);

      const result = await TokocryptoServices.whitelistedRequest({
        method,
        endpoint,
        params,
      });

      TokocryptoServices.clearCredentials();

      return c.json(result);
    } catch (e) {
      console.error(e, "ERROR 500 PLAYGROUND tokocryptoServices");
      TokocryptoServices.clearCredentials();

      if (e instanceof Error) {
        return c.json(
          {
            message: "ERROR!",
            error: e.message,
          },
          { status: 500 },
        );
      }
      return c.json(
        {
          message: "ERROR!",
          error: "UNKNOWN ERROR",
        },
        { status: 500 },
      );
    }
  },
};
