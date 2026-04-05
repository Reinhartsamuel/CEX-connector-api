/* eslint-disable @typescript-eslint/no-explicit-any */
import { Context } from "hono";
import { MexcServices } from "../../services/mexcServices";
import type { MexcOrder } from "../../schemas/interfaces";
import * as z from "zod";
import { postgresDb } from "../../db/client";
import { exchanges, trades } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import * as JSONbig from "json-bigint";
import redis from "../../db/redis";
import {
  decrypt,
  generateAndEncryptCredentials,
  getOrDecryptDEK,
} from "../../utils/cryptography/kmsUtils";
import {
  mexcRegisterUserSchema,
  mexcPlaceOrderSchema,
  mexcCancelOrderSchema,
  mexcClosePositionSchema,
} from "../../schemas/mexcSchemas";

export const MexcHandler = {
  /**
   * Unwraps and decrypts the credentials for a given exchange ID.
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

    const dek = await getOrDecryptDEK(exchange.id, exchange.enc_dek!);

    const decryptedApiKey = decrypt(JSON.parse(exchange.api_key_encrypted), dek);
    const decryptedApiSecret = decrypt(JSON.parse(exchange.api_secret_encrypted), dek);

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
        typeof mexcRegisterUserSchema
      >;
      let { api_key, api_secret, user_id } = body;

      // Initialize with credentials
      MexcServices.initialize(api_key, api_secret);

      // Check if exchange already registered
      const existing = await postgresDb.query.exchanges.findFirst({
        where: and(
          eq(exchanges.exchange_title, "mexc"),
          eq(exchanges.user_id, user_id),
        ),
      });

      if (existing?.id)
        return c.json(
          {
            message: "ERROR!",
            error: `exchange already registered for 'mexc' user_id ${user_id} with exchange id ${existing.id}`,
          },
          { status: 400 },
        );

      // Validate credentials by fetching account balance
      const balance = await MexcServices.fetchBalance();

      // Clear credentials from service
      MexcServices.clearCredentials();

      if (balance.status === "error")
        return c.json(
          {
            ...balance,
          },
          { status: balance.statusCode },
        );

      // Extract user ID from balance info
      const accountInfo = balance.info || {};
      const mexcUserId = accountInfo.uid || `mexc_${user_id}`;

      // Encrypt credentials using KMS (no passphrase for MEXC)
      const {
        encryptedDEK,
        apiKey: encryptedApiKey,
        apiSecret: encryptedApiSecret,
      } = await generateAndEncryptCredentials(
        api_key,
        api_secret,
      );

      // clear memory
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
          exchange_title: "mexc",
          exchange_user_id: mexcUserId,
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
      console.error(e, "ERROR 500 REGISTER USER mexc");
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
      const body = await c.req.json() as z.infer<typeof mexcPlaceOrderSchema>;

      // Unwrap credentials
      let {
        api_key,
        api_secret,
        user_id,
        exchange_user_id
      } = await MexcHandler.unwrapCredentials(body.exchange_id);

      // Initialize CCXT service
      MexcServices.initialize(api_key, api_secret);

      // Clear credentials from memory immediately
      api_key = '';
      api_secret = '';

      const allReturn: { message: string; data: any } = {
        message: "ok",
        data: {},
      };

      // Update leverage and margin mode (futures only)
      const resLeverage = await MexcServices.updateLeverage(
        body.contract,
        body.leverage
      );
      allReturn.data.resLeverage = resLeverage;

      const resMarginMode = await MexcServices.updateMarginMode(
        body.contract,
        body.leverage_type
      );
      allReturn.data.resMarginMode = resMarginMode;

      // Build order payload
      const orderPayload: MexcOrder = {
        contract: body.contract,
        position_type: body.position_type,
        market_type: body.market_type,
        size: body.size,
        price: body.price,
        reduce_only: body.reduce_only,
      };

      // Place order via CCXT
      const ccxtOrder = await MexcServices.placeOrder(orderPayload);
      allReturn.data.ccxtOrder = ccxtOrder;

      // Map CCXT status to DB status
      const tradeStatus = MexcServices.mapCcxtStatusToDb(
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
        metadata: JSON.parse(JSONbig.stringify(ccxtOrder)),
      };

      // Insert trade record
      const newTrade = await postgresDb
        .insert(trades)
        .values(addData as any)
        .returning();

      allReturn.data.newTrade = newTrade;

      // Publish WebSocket control message to Redis Stream
      await redis.xadd(
        'ws-control:mexc', '*',
        'op', 'open',
        'userId', String(exchange_user_id),
        'contract', body.contract,
      );

      // Clear CCXT credentials
      MexcServices.clearCredentials();

      return c.json(allReturn);
    } catch (e) {
      console.error(e, "ERROR 500 ORDER mexc");

      // Clear credentials on error
      MexcServices.clearCredentials();

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
      const body = await c.req.json() as z.infer<typeof mexcCancelOrderSchema>;

      let { api_key, api_secret, user_id } =
        await MexcHandler.unwrapCredentials(body.exchange_id);

      MexcServices.initialize(api_key, api_secret);
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
          const resultCancel = await MexcServices.cancelOrder(
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
            console.log(`Canceling status: ${result.status} failed!!!`);
          }
        })
      );

      MexcServices.clearCredentials();

      return c.json(results);
    } catch (e) {
      console.error(e, "ERROR 500 CANCEL ORDER mexc");
      MexcServices.clearCredentials();

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
      const body = await c.req.json() as z.infer<typeof mexcClosePositionSchema>;

      const { api_key, api_secret, user_id } =
        await MexcHandler.unwrapCredentials(body.exchange_id);

      MexcServices.initialize(api_key, api_secret);

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
          const closePayload: MexcOrder = {
            contract: trade.contract,
            position_type: trade.position_type === 'long' ? 'short' : 'long',
            market_type: 'market',
            size: Math.abs(parseFloat(trade.size)),
            reduce_only: true,
          };

          const ccxtOrder = await MexcServices.placeOrder(closePayload);

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

      MexcServices.clearCredentials();

      return c.json({
        running_trades,
        user_id,
        closed_trades,
      });
    } catch (e) {
      console.error(e, "ERROR 500 CLOSE POSITION mexc");
      MexcServices.clearCredentials();

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
        await MexcHandler.unwrapCredentials(exchange_id);

      MexcServices.initialize(api_key, api_secret);

      const result = await MexcServices.whitelistedRequest({
        method,
        endpoint,
        params,
      });

      MexcServices.clearCredentials();

      return c.json(result);
    } catch (e) {
      console.error(e, "ERROR 500 PLAYGROUND mexc");
      MexcServices.clearCredentials();

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