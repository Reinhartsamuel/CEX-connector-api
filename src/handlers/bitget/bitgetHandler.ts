/* eslint-disable @typescript-eslint/no-explicit-any */
import { Context } from "hono";
import { BitgetServices } from "../../services/bitgetServices";
import type { BitgetOrder } from "../../schemas/interfaces";
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
import { createLogger } from '../../utils/logger';

const log = createLogger({ exchange: 'bitget', process: 'handler' });
  bitgetRegisterUserSchema,
  bitgetPlaceOrderSchema,
  bitgetCancelOrderSchema,
  bitgetClosePositionSchema,
} from "../../schemas/bitgetSchemas";

export const BitgetHandler = {
  /**
   * Unwraps and decrypts the credentials for a given exchange ID.
   */
  unwrapCredentials: async function (exchangeId: number): Promise<{
    api_key: string;
    api_secret: string;
    api_passphrase: string;
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
    const decryptedApiPassphrase = decrypt(JSON.parse(exchange.api_passphrase_encrypted!), dek);

    return {
      api_key: decryptedApiKey,
      api_secret: decryptedApiSecret,
      api_passphrase: decryptedApiPassphrase,
      user_id: exchange.user_id,
      encrypted_api_key: exchange.api_key_encrypted,
      encrypted_api_secret: exchange.api_secret_encrypted,
      exchange_user_id: exchange.exchange_user_id,
    };
  },

  registerUser: async function (c: Context) {
    try {
      const body = (await c.req.json()) as z.infer<
        typeof bitgetRegisterUserSchema
      >;
      let { api_key, api_secret, api_password, user_id } = body;

      // Initialize with credentials
      BitgetServices.initialize(api_key, api_secret, api_password);

      // Check if exchange already registered
      const existing = await postgresDb.query.exchanges.findFirst({
        where: and(
          eq(exchanges.exchange_title, "bitget"),
          eq(exchanges.user_id, user_id),
        ),
      });

      if (existing?.id)
        return c.json(
          {
            message: "ERROR!",
            error: `exchange already registered for 'bitget' user_id ${user_id} with exchange id ${existing.id}`,
          },
          { status: 400 },
        );

      // Validate credentials by fetching account balance
      const balance = await BitgetServices.fetchBalance();

      // Clear credentials from service
      BitgetServices.clearCredentials();

      if (balance.status === "error")
        return c.json(
          {
            ...balance,
          },
          { status: balance.statusCode },
        );

      // Extract user ID from balance info
      const accountInfo = balance.info || {};
      const bitgetUserId = accountInfo.uid || `bitget_${user_id}`;

      // Encrypt credentials using KMS
      const {
        encryptedDEK,
        apiKey: encryptedApiKey,
        apiSecret: encryptedApiSecret,
        passphrase: encryptedPassphrase,
      } = await generateAndEncryptCredentials(
        api_key,
        api_secret,
        api_password,
      );

      // clear memory
      api_key = '';
      api_secret = '';
      api_password = '';

      // Serialize encrypted payloads for DB
      const apiKeyCiphertext = JSON.stringify(encryptedApiKey);
      const apiSecretCiphertext = JSON.stringify(encryptedApiSecret);
      const passphraseCiphertext = JSON.stringify(encryptedPassphrase);

      // Insert into database
      const exchangeRecord = await postgresDb
        .insert(exchanges)
        .values({
          user_id,
          exchange_title: "bitget",
          exchange_user_id: bitgetUserId,
          market_type: "futures",
          api_key_encrypted: apiKeyCiphertext,
          api_secret_encrypted: apiSecretCiphertext,
          api_passphrase_encrypted: passphraseCiphertext,
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
      log.error({ err: e }, 'ERROR 500 REGISTER USER bitget');
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
      const body = await c.req.json() as z.infer<typeof bitgetPlaceOrderSchema>;

      // Unwrap credentials
      let {
        api_key,
        api_secret,
        api_passphrase,
        user_id,
        exchange_user_id
      } = await BitgetHandler.unwrapCredentials(body.exchange_id);

      // Initialize CCXT service
      BitgetServices.initialize(api_key, api_secret, api_passphrase);

      // Clear credentials from memory immediately
      api_key = '';
      api_secret = '';
      api_passphrase = '';

      const allReturn: { message: string; data: any } = {
        message: "ok",
        data: {},
      };

      // Update leverage and margin mode (futures only)
      const resLeverage = await BitgetServices.updateLeverage(
        body.contract,
        body.leverage
      );
      allReturn.data.resLeverage = resLeverage;

      const resMarginMode = await BitgetServices.updateMarginMode(
        body.contract,
        body.leverage_type
      );
      allReturn.data.resMarginMode = resMarginMode;

      // Build order payload
      const orderPayload: BitgetOrder = {
        contract: body.contract,
        position_type: body.position_type,
        market_type: body.market_type,
        size: body.size,
        price: body.price,
        reduce_only: body.reduce_only,
      };

      // Place order via CCXT
      const ccxtOrder = await BitgetServices.placeOrder(orderPayload);
      allReturn.data.ccxtOrder = ccxtOrder;

      // Map CCXT status to DB status
      const tradeStatus = BitgetServices.mapCcxtStatusToDb(
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
        'ws-control:bitget', '*',
        'op', 'open',
        'userId', String(exchange_user_id),
        'contract', body.contract,
      );

      // Clear CCXT credentials
      BitgetServices.clearCredentials();

      return c.json(allReturn);
    } catch (e) {
      log.error({ err: e }, 'ERROR 500 ORDER bitget');

      // Clear credentials on error
      BitgetServices.clearCredentials();

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
      const body = await c.req.json() as z.infer<typeof bitgetCancelOrderSchema>;

      let { api_key, api_secret, api_passphrase, user_id } =
        await BitgetHandler.unwrapCredentials(body.exchange_id);

      BitgetServices.initialize(api_key, api_secret, api_passphrase);
      api_key = '';
      api_secret = '';
      api_passphrase = '';

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
          const resultCancel = await BitgetServices.cancelOrder(
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
            log.info({}, 'Canceling status: ${result.status} failed!!!');
          }
        })
      );

      BitgetServices.clearCredentials();

      return c.json(results);
    } catch (e) {
      log.error({ err: e }, 'ERROR 500 CANCEL ORDER bitget');
      BitgetServices.clearCredentials();

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
      const body = await c.req.json() as z.infer<typeof bitgetClosePositionSchema>;

      const { api_key, api_secret, api_passphrase, user_id } =
        await BitgetHandler.unwrapCredentials(body.exchange_id);

      BitgetServices.initialize(api_key, api_secret, api_passphrase);

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
          const closePayload: BitgetOrder = {
            contract: trade.contract,
            position_type: trade.position_type === 'long' ? 'short' : 'long',
            market_type: 'market',
            size: Math.abs(parseFloat(trade.size)),
            reduce_only: true,
          };

          const ccxtOrder = await BitgetServices.placeOrder(closePayload);

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

      BitgetServices.clearCredentials();

      return c.json({
        running_trades,
        user_id,
        closed_trades,
      });
    } catch (e) {
      log.error({ err: e }, 'ERROR 500 CLOSE POSITION bitget');
      BitgetServices.clearCredentials();

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

      const { api_key, api_secret, api_passphrase } =
        await BitgetHandler.unwrapCredentials(exchange_id);

      BitgetServices.initialize(api_key, api_secret, api_passphrase);

      const result = await BitgetServices.whitelistedRequest({
        method,
        endpoint,
        params,
      });

      BitgetServices.clearCredentials();

      return c.json(result);
    } catch (e) {
      log.error({ err: e }, 'ERROR 500 PLAYGROUND bitget');
      BitgetServices.clearCredentials();

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