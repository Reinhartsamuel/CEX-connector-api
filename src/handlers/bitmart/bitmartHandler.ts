/* eslint-disable @typescript-eslint/no-explicit-any */
import { Context } from "hono";
import { BitmartServices } from "../../services/bitmartServices";
import type { BitmartOrder } from "../../schemas/interfaces";
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

const log = createLogger({ exchange: 'bitmart', process: 'handler' });
  bitmartRegisterUserSchema,
  bitmartPlaceOrderSchema,
  bitmartCancelOrderSchema,
  bitmartClosePositionSchema,
} from "../../schemas/bitmartSchemas";

export const BitmartHandler = {
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
      api_passphrase: decryptedApiPassphrase, // This is the memo/uid for BitMart
      user_id: exchange.user_id,
      encrypted_api_key: exchange.api_key_encrypted,
      encrypted_api_secret: exchange.api_secret_encrypted,
      exchange_user_id: exchange.exchange_user_id,
    };
  },

  registerUser: async function (c: Context) {
    try {
      const body = (await c.req.json()) as z.infer<
        typeof bitmartRegisterUserSchema
      >;
      let { api_key, api_secret, api_memo, user_id } = body;

      // Initialize with credentials (memo is used as uid/passphrase equivalent)
      BitmartServices.initialize(api_key, api_secret, api_memo);

      // Check if exchange already registered
      const existing = await postgresDb.query.exchanges.findFirst({
        where: and(
          eq(exchanges.exchange_title, "bitmart"),
          eq(exchanges.user_id, user_id),
        ),
      });

      if (existing?.id)
        return c.json(
          {
            message: "ERROR!",
            error: `exchange already registered for 'bitmart' user_id ${user_id} with exchange id ${existing.id}`,
          },
          { status: 400 },
        );

      // Validate credentials by fetching account balance
      const balance = await BitmartServices.fetchBalance();

      // Clear credentials from service
      BitmartServices.clearCredentials();

      if (balance.status === "error")
        return c.json(
          {
            ...balance,
          },
          { status: balance.statusCode },
        );

      // Extract user ID from balance info
      const accountInfo = balance.info || {};
      const bitmartUserId = accountInfo.uid || `bitmart_${user_id}`;

      // Encrypt credentials using KMS (memo stored as passphrase)
      const {
        encryptedDEK,
        apiKey: encryptedApiKey,
        apiSecret: encryptedApiSecret,
        passphrase: encryptedPassphrase,
      } = await generateAndEncryptCredentials(
        api_key,
        api_secret,
        api_memo,
      );

      // clear memory
      api_key = '';
      api_secret = '';
      api_memo = '';

      // Serialize encrypted payloads for DB
      const apiKeyCiphertext = JSON.stringify(encryptedApiKey);
      const apiSecretCiphertext = JSON.stringify(encryptedApiSecret);
      const passphraseCiphertext = JSON.stringify(encryptedPassphrase);

      // Insert into database
      const exchangeRecord = await postgresDb
        .insert(exchanges)
        .values({
          user_id,
          exchange_title: "bitmart",
          exchange_user_id: bitmartUserId,
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
      log.error({ err: e }, 'ERROR 500 REGISTER USER bitmart');
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
      const body = await c.req.json() as z.infer<typeof bitmartPlaceOrderSchema>;

      // Unwrap credentials
      let {
        api_key,
        api_secret,
        api_passphrase,
        user_id,
        exchange_user_id
      } = await BitmartHandler.unwrapCredentials(body.exchange_id);

      // Initialize CCXT service (passphrase is memo for BitMart)
      BitmartServices.initialize(api_key, api_secret, api_passphrase);

      // Clear credentials from memory immediately
      api_key = '';
      api_secret = '';
      api_passphrase = '';

      const allReturn: { message: string; data: any } = {
        message: "ok",
        data: {},
      };

      // Update leverage only (BitMart does NOT support margin mode setting)
      const resLeverage = await BitmartServices.updateLeverage(
        body.contract,
        body.leverage
      );
      allReturn.data.resLeverage = resLeverage;

      // Build order payload
      const orderPayload: BitmartOrder = {
        contract: body.contract,
        position_type: body.position_type,
        market_type: body.market_type,
        size: body.size,
        price: body.price,
        reduce_only: body.reduce_only,
      };

      // Place order via CCXT
      const ccxtOrder = await BitmartServices.placeOrder(orderPayload);
      allReturn.data.ccxtOrder = ccxtOrder;

      // Map CCXT status to DB status
      const tradeStatus = BitmartServices.mapCcxtStatusToDb(
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
        'ws-control:bitmart', '*',
        'op', 'open',
        'userId', String(exchange_user_id),
        'contract', body.contract,
      );

      // Clear CCXT credentials
      BitmartServices.clearCredentials();

      return c.json(allReturn);
    } catch (e) {
      log.error({ err: e }, 'ERROR 500 ORDER bitmart');

      // Clear credentials on error
      BitmartServices.clearCredentials();

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
      const body = await c.req.json() as z.infer<typeof bitmartCancelOrderSchema>;

      let { api_key, api_secret, api_passphrase, user_id } =
        await BitmartHandler.unwrapCredentials(body.exchange_id);

      BitmartServices.initialize(api_key, api_secret, api_passphrase);
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
          const resultCancel = await BitmartServices.cancelOrder(
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

      BitmartServices.clearCredentials();

      return c.json(results);
    } catch (e) {
      log.error({ err: e }, 'ERROR 500 CANCEL ORDER bitmart');
      BitmartServices.clearCredentials();

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
      const body = await c.req.json() as z.infer<typeof bitmartClosePositionSchema>;

      const { api_key, api_secret, api_passphrase, user_id } =
        await BitmartHandler.unwrapCredentials(body.exchange_id);

      BitmartServices.initialize(api_key, api_secret, api_passphrase);

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
          const closePayload: BitmartOrder = {
            contract: trade.contract,
            position_type: trade.position_type === 'long' ? 'short' : 'long',
            market_type: 'market',
            size: Math.abs(parseFloat(trade.size)),
            reduce_only: true,
          };

          const ccxtOrder = await BitmartServices.placeOrder(closePayload);

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

      BitmartServices.clearCredentials();

      return c.json({
        running_trades,
        user_id,
        closed_trades,
      });
    } catch (e) {
      log.error({ err: e }, 'ERROR 500 CLOSE POSITION bitmart');
      BitmartServices.clearCredentials();

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
        await BitmartHandler.unwrapCredentials(exchange_id);

      BitmartServices.initialize(api_key, api_secret, api_passphrase);

      const result = await BitmartServices.whitelistedRequest({
        method,
        endpoint,
        params,
      });

      BitmartServices.clearCredentials();

      return c.json(result);
    } catch (e) {
      log.error({ err: e }, 'ERROR 500 PLAYGROUND bitmart');
      BitmartServices.clearCredentials();

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