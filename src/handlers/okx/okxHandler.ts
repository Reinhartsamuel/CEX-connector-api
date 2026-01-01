/* eslint-disable no-alert */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Context } from "hono";
import { GateServices } from "../../services/gateServices";
import {
  GateFuturesOrder,
  GateTriggerPriceOrder,
  OkxOrder,
} from "../../schemas/interfaces";
import {
  closeFuturesPositionSchema,
  gatePlaceFuturesOrdersSchema,
  gateRegisterUserSchema,
} from "../../schemas/gateSchemas";
import * as z from "zod";
import { getOrderType } from "../../utils/getOrderType";
import { getTriggerRule } from "../../utils/getTriggerRule";
import { mapPriceType } from "../../utils/mapPriceType";
import { set } from "../../utils/cache";
import Redis from "ioredis";
import { postgresDb } from "../../db/client";
import { exchanges, trades, users } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import * as JSONbig from "json-bigint";
import redis from "../../db/redis";
import { OkxServices } from "../../services/okxServices";
import {
  decrypt,
  generateAndEncryptCredentials,
  kmsClient,
} from "../../utils/cryptography/kmsUtils";
import { DecryptCommand } from "@aws-sdk/client-kms";
import { okxCancelOrderSchema, okxRegisterUserSchema } from "../../schemas/okxSchemas";

export const OkxHandler = {
  /**
    Unwraps and decrypts the credentials in both plaintext and encrypted form for a given exchange ID.
    @returns {
      api_key: string;
      api_secret: string;
      user_id: number;
      encrypted_api_key: string;
      encrypted_api_secret: string;
      encrypted_user_id: string;
    }
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
    const decryptedApiPassphrase = decrypt(
      JSON.parse(exchange.api_passphrase_encrypted!),
      plaintextDEK,
    );

    // zero
    plaintextDEK.fill(0);

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
        typeof okxRegisterUserSchema
      >;
      const { api_key, api_secret, api_passphrase, user_id } = body;

      OkxServices.initialize(api_key, api_secret, api_passphrase);
      // find first on exchanges where exchange_title = 'okx' and user_id = user_id
      const existing = await postgresDb.query.exchanges.findFirst({
        where: and(
          eq(exchanges.exchange_title, "okx"),
          eq(exchanges.user_id, user_id),
        ),
      });

      if (existing?.id)
        return c.json(
          {
            message: "ERROR!",
            error: `exchange already registered for 'okx' user_id ${user_id} with exchange id ${existing.id}`,
          },
          { status: 400 },
        );

      // get account info
      const reqAccount = await OkxServices.whitelistedRequest({
        method: "GET",
        requestPath: "/api/v5/account/config",
        payloadString: undefined
      });
      if (reqAccount.status === "error")
        return c.json(
          {
            ...reqAccount,
          },
          { status: reqAccount.statusCode },
        );
      const account = reqAccount?.data[0];
      console.log(account, "account");

      const permissions = account?.perm ? account.perm?.split(",") : [];
      if (!permissions.includes("trade"))
        return c.json(
          {
            message:
              "User does not have trade permissions, please create new API KEYS with TRADE permission",
            permissions,
            status: "error",
          },
          { status: 403 },
        );

      // const ip = account?.ip ? account.ip?.split(",") : [];
      // if (!ip.includes("123.232.42.5")) {
      //   return c.json(
      //     {
      //       message:
      //         "User IP is not whitelisted, please create new API KEYS with IP permission 123.232.42.5",
      //       ip,
      //       status: "error",
      //     },
      //     { status: 403 },
      //   );
      // }

      // ---- Encrypt credentials (KMS GenerateDataKey happens here) ----
      const {
        encryptedDEK,
        apiKey: encryptedApiKey,
        apiSecret: encryptedApiSecret,
        passphrase,
      } = await generateAndEncryptCredentials(
        api_key,
        api_secret,
        api_passphrase,
      );

      // Serialize AES payloads for DB
      const apiKeyCiphertext = JSON.stringify(encryptedApiKey);
      const apiSecretCiphertext = JSON.stringify(encryptedApiSecret);
      const passphraseCiphertext = JSON.stringify(passphrase);

      // TODO: DELETE BEFORE PUSHING
      const dekResp = await kmsClient.send(
        new DecryptCommand({
          CiphertextBlob: encryptedDEK,
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        }),
      );
      if (!dekResp.Plaintext) throw new Error("KMS decrypt failed");

      const exchangeRecord = await postgresDb
        .insert(exchanges)
        .values({
          user_id,
          exchange_title: "okx",
          exchange_user_id: account.uid,
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
        account,
        exchangeRecord,
      });
    } catch (e) {
      console.error(e, "ERROR 500 REGISTER USER okxServices");
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
      const body = await c.req.json() as z.infer<
        typeof gatePlaceFuturesOrdersSchema>;
      const {
        api_key,
        api_secret,
        api_passphrase,
        user_id
      } = await OkxHandler.unwrapCredentials(body.exchange_id);

      OkxServices.initialize(api_key, api_secret, api_passphrase);

      const allReturn: { message: string; data: any } = {
        message: "ok",
        data: null,
      };

      const resSetPositionMode = await OkxServices.whitelistedRequest({
        method: "POST",
        requestPath: "/api/v5/account/set-position-mode",
        payloadString: JSON.stringify({
          instId: body.contract,
          lever: body.leverage,
          mgnMode: body.leverage_type,
          posMode:"long_short_mode"
        }),
      });

      const reqAccount = await OkxServices.whitelistedRequest({
        method: "GET",
        requestPath: "/api/v5/account/config",
        payloadString: undefined
      });

      allReturn.data = {
        ...allReturn.data,
        resSetPositionMode,
        reqAccount
      };

      const payload: OkxOrder = {
        instId: body.contract,
        tdMode: body.leverage_type,
        clOrdId: "", //mirip text di gate
        tag: "", //mirip text di gate juga
        side: body.position_type === 'long' ? 'buy' : 'sell',
        posSide: body.position_type, // long or short in futures, on spot not required
        ordType: body.market_type,
        px: body.price ? String(body.price) : '',
        sz: String(body.size),
        reduceOnly: body.reduce_only,
        ...(body?.price && { price: String(body.price) }),


        ...((body?.take_profit.enabled || body?.stop_loss.enabled) && {
          attachAlgoOrds: [
            {
              ...(body?.take_profit?.enabled && {
                tpTriggerPx: String(body.take_profit.price),
                tpTriggerPxType: body.take_profit.price_type,
                tpOrdPx: "-1",        // market when triggered
              }),

              ...(body?.stop_loss?.enabled && {
                slTriggerPx: String(body.stop_loss.price),
                slTriggerPxType: body.stop_loss.price_type,
                slOrdPx: "-1",        // market when triggered
              }),
            },
          ],
        }),
        // ...(body.attachAlgoOrds && body.attachAlgoOrds.length > 0 && { attachAlgoOrds: body.attachAlgoOrds }),
        // ...(body.closeOrderAlgo && body.closeOrderAlgo.length > 0 && { closeOrderAlgo: body.closeOrderAlgo }),
      };

      console.log(payload,'payload order okx')



      const resPlaceOrder = await OkxServices.placeOrder(payload);
      allReturn.data = {
        ...allReturn.data,
        resPlaceOrder,
      };
      const tradeStatus = () => {
        if (resPlaceOrder.code === '0') {
          return body.market_type === 'market' ? "waiting_targets":
          body.market_type === 'limit' ? 'waiting_position' : 'unknown';
        }
        if (resPlaceOrder.code === '1') return 'error';
      };

      const addData = {
        user_id: user_id,
        exchange_id: body.exchange_id,
        trade_id: resPlaceOrder.data[0]?.ordId || '',
        open_order_id: resPlaceOrder.data[0]?.ordId || '',
        autotrader_id:body.autotrader_id,
        order_id: resPlaceOrder.data[0]?.ordId || '',
        contract: body.contract,
        position_type: body.position_type,
        market_type: body.market_type,
        size: body.size,
        leverage: body?.leverage || 1,
        leverage_type: body?.leverage_type || "ISOLATED",
        status: tradeStatus(),
        price: body.price,
        reduce_only: body.reduce_only,
        is_tpsl: false,

        //take profit:
        take_profit_enabled: body.take_profit.enabled,
        take_profit_executed: (body.take_profit.enabled && resPlaceOrder.code === '0'),
        take_profit_price: body.take_profit.enabled
          ? Number(body.take_profit.price)
          : 0,
        take_profit_price_type: body.take_profit.enabled
          ? body.take_profit.price_type
          : "",

        //stop loss:
        stop_loss_enabled: body.stop_loss.enabled,
        stop_loss_executed: (body.stop_loss.enabled && resPlaceOrder.code === '0'),
        stop_loss_price: body.stop_loss.enabled
          ? Number(body.stop_loss.price)
          : 0,
        stop_loss_price_type: body.stop_loss.enabled
          ? body.stop_loss.price_type
          : "",

        metadata: JSON.parse(JSONbig.stringify(resPlaceOrder)),
      };
      console.log(JSON.stringify(addData),'addData')
      const newTrade = await postgresDb
        .insert(trades)
        .values(addData as any)
        .returning();
      allReturn.data = {
        ...allReturn.data,
        newTrade,
      };

      // Store credentials and trigger WebSocket connection
      // await redis.hset(
      //   `okx:creds:${body.user_id}`,
      //   "apiKey",
      //   api_key,
      //   "apiSecret",
      //   api_secret,
      // );
      // await redis.publish(
      //   "ws-control",
      //   JSON.stringify({
      //     op: "open",
      //     userId: String(body.user_id),
      //     contract: body.contract,
      //   }),
      // );
      return c.json(allReturn);
    } catch (e) {
      if (e instanceof Error) {
        return c.json(
          {
            message: "ERROR!",
            error: e.message,
          },
          { status: 500 },
        );
      }
      return c.json({
        message: "Unexpected Error happened",
      });
    }
  },

  cancelOrder : async function (c:Context) {
    const body = (await c.req.json())as z.infer<
      typeof okxCancelOrderSchema
    >;
    const { api_key, api_secret, api_passphrase, user_id } =
      await OkxHandler.unwrapCredentials(body.exchange_id);
    OkxServices.initialize(api_key, api_secret, api_passphrase);



    // get trades from trades table by autotrader_i && contract from body
    const foundTrades = await postgresDb.query.trades.findMany({
      where: and(
        eq(trades.autotrader_id, body.autotrader_id),
        eq(trades.contract, body.contract)
      ),
    });

    const results = await Promise.allSettled(foundTrades.map(async (trade) => {
      const resultCancel = await OkxServices.cancelOrder({
        instId: trade.contract,
        ordId: trade.order_id,
      });
      return {...resultCancel, id: trade.id}
    }));

    await Promise.allSettled(
      results.map(async (result) => {
        if (result?.status === 'fulfilled' && result?.value?.code === '0') {
          await postgresDb
            .update(trades)
            .set({ status: 'cancelled' })
            .where(eq(result.value.id, result.value.id));
        } else {
          console.log(`${JSON.stringify(result)}, cancelling status: ${result.status} failed!!!❌🅾❌`)
        }
      })
    )

    return c.json(results)
  },
  closePositionDb: async function (c: Context) {
    try {
      // GateServices.initialize(process.env.GATE_API_KEY!, process.env.GATE_API_SECRET!);
      const body = (await c.req.json()) as z.infer<
        typeof closeFuturesPositionSchema
      >;
      const { api_key, api_secret, user_id } =
        await OkxHandler.unwrapCredentials(body.exchange_id);
      GateServices.initialize(api_key, api_secret);
      GateServices.initialize(api_key, api_secret);

      // find on trades table where exchange id and contract and status === 'waiting_targets'

      // Fixed query with proper SQL expressions
      const running_trades = await postgresDb.query.trades.findMany({
        where: and(
          eq(trades.exchange_id, body.exchange_id),
          eq(trades.contract, body.contract),
          eq(trades.status, "waiting_targets"),
        ),
      });

      const closed_trades = await Promise.all(
        running_trades.map(async (trade) => {
          const orderPayload: GateFuturesOrder = {
            contract: body.contract,
            size: parseFloat(trade.size) * -1,
            price: "0",
            tif: "ioc",
            iceberg: 0,
            reduce_only: true,
            auto_size: "",
            settle: "usdt",
          };
          const res = await GateServices.placeFuturesOrder(orderPayload);
          if (
            res?.status === "finished" &&
            res?.finish_as === "filled" &&
            res?.left === 0
          ) {
            // update status and pnl
            postgresDb.update(trades).set({
              status: "closed",
              close_order_id: res.id,
              pnl: res.pnl,
              pnl_margin: res.pnl_margin,
              closed_at: new Date(),
            });
          }
          return res;
        }),
      );

      return c.json({
        running_trades,
        user_id,
        closed_trades,
      });
      // const res = await GateServices.closeFuturesOrder(body);
      // return c.json(res);
    } catch (e) {
      console.error(e, "ERROR 500 CLOSE POSITION");
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
      const api_key = c.req.header("api-key")!;
      const api_secret = c.req.header("api-secret")!;
      const api_passphrase = c.req.header("api-passphrase")!;

      OkxServices.initialize(api_key, api_secret, api_passphrase);
      const body = (await c.req.json()) as {
        method: string;
        requestPath: string;
        payload: any;
      };

      const res = await OkxServices.whitelistedRequest({
        method: body.method,
        requestPath: body.requestPath,
        payloadString: body.payload ? JSON.stringify(body.payload) : undefined,
      });

      return c.json(res);
    } catch (e) {
      console.error(e, "ERROR 500 GET ORDER DETAILS");
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
