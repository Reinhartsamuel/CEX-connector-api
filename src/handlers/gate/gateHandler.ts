/* eslint-disable no-alert */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Context } from "hono";
import { GateServices } from "../../services/gateServices";
import {
  GateFuturesOrder,
  GateTriggerPriceOrder,
} from "../../schemas/interfaces";
import {
  closeFuturesPositionSchema,
  gateRegisterUserSchema,
  gatePlaceFuturesOrdersSchema,
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
import {
  decrypt,
  generateAndEncryptCredentials,
  kmsClient,
} from "../../utils/cryptography/kmsUtils";
import { DecryptCommand } from "@aws-sdk/client-kms";

export const GateHandler = {
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
    user_id: number;
    encrypted_api_key: string;
    encrypted_api_secret: string;
    exchange_user_id: string;
  }> {
    const exchange = await postgresDb.query.exchanges.findFirst({
      where: eq(exchanges.id, exchangeId),
    });
    if (!exchange) throw new Error("exchange not found");

    // ========= use Vault/KMS to encrypt and decrypt the credentials ======
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

    // zero
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
  futuresOrder: async function (c: Context) {
    try {
      const body = (await c.req.json()) as z.infer<
        typeof gatePlaceFuturesOrdersSchema
      >;
      // GateServices.initialize(process.env.GATE_API_KEY!, process.env.GATE_API_SECRET!);
      const api_key = c.req.header("api-key")!;
      const api_secret = c.req.header("api-secret")!;
      GateServices.initialize(api_key, api_secret);
      const allReturn: { message: string; data: any } = {
        message: "ok",
        data: null,
      };

      const redis = new Redis(
        process.env.REDIS_URL || "redis://127.0.0.1:6379",
      );

      console.log("updating leverage");
      // update leverage
      const resLeverage = await GateServices.updateLeverage(
        body.contract,
        body.leverage,
      );
      console.log(resLeverage, "resLeverage");

      // update margin mode
      const resMarginMode = await GateServices.updateMarginMode(
        body.contract,
        body.leverage_type,
      );
      console.log(resMarginMode, "resMarginMode");

      // normalize size sign for entry order (API expects positive to open long, negative to open short)
      let sizeForOrder = body.size;
      if (body.position_type === "short" && sizeForOrder > 0) {
        sizeForOrder = -sizeForOrder;
      }
      let priceStr = body.price.toString();
      let tif = "gtc";
      if (body.market_type === "market") {
        tif = "ioc";
        priceStr = "0";
      }

      const orderPayload: GateFuturesOrder = {
        contract: body.contract,
        size: sizeForOrder,
        price: priceStr,
        tif: tif,
        iceberg: 0,
        reduce_only: body.reduce_only || false,
        auto_size: "",
        settle: "usdt",
      };
      console.log(orderPayload, "orderPayload");
      const resPlaceOrder = await GateServices.placeFuturesOrder(orderPayload);
      console.log(resPlaceOrder, "resPlaceOrder");
      if (resPlaceOrder?.status) {
        set(
          `trade:${resPlaceOrder.id}`,
          {
            ...resPlaceOrder,
            take_profit: body.take_profit.enabled
              ? { ...body.take_profit, executed: false }
              : null,
            stop_loss: body.stop_loss.enabled
              ? { ...body.stop_loss, executed: false }
              : null,
          },
          null,
        );
      }
      allReturn.data = { resPlaceOrder };

      // Store credentials and trigger WebSocket connection
      await redis.hset(
        `gate:creds:${body.user_id}`,
        "apiKey",
        api_key,
        "apiSecret",
        api_secret,
      );
      await redis.publish(
        "ws-control",
        JSON.stringify({
          op: "open",
          userId: String(body.user_id),
          contract: body.contract,
        }),
      );

      // // orderType used by both TP and SL blocks
      // const orderType = getOrderType(body.position_type);
      // let initialPrice = orderType.includes("position") ? "0" : priceStr;

      // let autoSize = "close_long";
      // if (body.position_type == "short") {
      //   autoSize = "close_short";
      // }

      // if (body.take_profit.enabled && ) {
      //   const payload: GateTriggerPriceOrder = {
      //     initial: {
      //       contract: body.contract,
      //       price: initialPrice,
      //       tif: tif,
      //       auto_size: autoSize,
      //       size: 0,
      //       reduce_only: true,
      //     },
      //     trigger: {
      //       strategy_type: 0,
      //       price_type: mapPriceType(body.take_profit.price_type),
      //       price: body.take_profit.price,
      //       rule: getTriggerRule(body.position_type, true),
      //     },
      //     order_type: body.market_type === 'market' ? orderType : undefined,
      //   };
      //   console.log(payload, "PAYLOAD TP");
      //   const resTP = await GateServices.triggerPriceOrder(payload);
      //   allReturn.data.take_profit = resTP;
      // }

      // if (body.stop_loss.enabled) {
      //   const payload: GateTriggerPriceOrder = {
      //     initial: {
      //       contract: body.contract,
      //       price: initialPrice,
      //       tif: tif,
      //       auto_size: autoSize,
      //       size: 0,
      //       reduce_only: true,
      //     },
      //     trigger: {
      //       strategy_type: 0,
      //       price_type: mapPriceType(body.stop_loss.price_type),
      //       price: body.stop_loss.price,
      //       rule: getTriggerRule(body.position_type, false),
      //     },
      //     order_type: body.market_type === 'market' ? orderType : undefined,
      //   };
      //   console.log(payload, "PAYLOAD SL");
      //   const resSL = await GateServices.triggerPriceOrder(payload);
      //   allReturn.data.stop_loss = resSL;
      // }

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
  placeTpSl: async function (c: Context) {
    const body = await c.req.json();
    // as z.infer<typeof kuda>;
    const api_key = c.req.header("api-key")!;
    const api_secret = c.req.header("api-secret")!;
    GateServices.initialize(api_key, api_secret);

    // orderType used by both TP and SL blocks
    const orderType = getOrderType(body.position_type);
    const initialPrice = orderType.includes("position")
      ? "0"
      : body.trigger_price.toString();

    let autoSize = "close_long";
    if (body.position_type == "short") {
      autoSize = "close_short";
    }

    if (body.take_profit.enabled) {
      const payload: GateTriggerPriceOrder = {
        initial: {
          contract: body.contract,
          price: initialPrice,
          tif: "gtc",
          auto_size: autoSize,
          size: 0,
          reduce_only: true,
        },
        trigger: {
          strategy_type: 0,
          price_type: mapPriceType(body.take_profit.price_type),
          price: body.take_profit.price,
          rule: getTriggerRule(body.position_type, true),
        },
        order_type: body.market_type === "market" ? orderType : undefined,
      };
      console.log(payload, "PAYLOAD TP");
      const resTP = await GateServices.triggerPriceOrder(payload);
      console.log(resTP, "resTP");
    }

    if (body.stop_loss.enabled) {
      const payload: GateTriggerPriceOrder = {
        initial: {
          contract: body.contract,
          price: initialPrice,
          tif: "gtc",
          auto_size: autoSize,
          size: 0,
          reduce_only: true,
        },
        trigger: {
          strategy_type: 0,
          price_type: mapPriceType(body.stop_loss.price_type),
          price: body.stop_loss.price,
          rule: getTriggerRule(body.position_type, false),
        },
        order_type: body.market_type === "market" ? orderType : undefined,
      };
      console.log(payload, "PAYLOAD SL");
      const resSL = await GateServices.triggerPriceOrder(payload);
      console.log(resSL, "resSL");
    }
  },
  // closePosition: async function (c: Context) {
  //   try {
  //     // GateServices.initialize(process.env.GATE_API_KEY!, process.env.GATE_API_SECRET!);
  //     const body = (await c.req.json()) as {
  //       contract: string;
  //       auto_size: "close_long" | "close_short";
  //     };
  //     const api_key = c.req.header("api-key")!;
  //     const api_secret = c.req.header("api-secret")!;
  //     GateServices.initialize(api_key, api_secret);
  //     const res = await GateServices.closeFuturesOrder(body);
  //     return c.json(res);
  //   } catch (e) {
  //     console.error(e, "ERROR 500 CLOSE POSITION");
  //     if (e instanceof Error) {
  //       return c.json(
  //         {
  //           message: "ERROR!",
  //           error: e.message,
  //         },
  //         { status: 500 },
  //       );
  //     }
  //     return c.json(
  //       {
  //         message: "ERROR!",
  //         error: "UNKNOWN ERROR",
  //       },
  //       { status: 500 },
  //     );
  //   }
  // },

  // cancelPosition: async function (c: Context) {
  //   try {
  //     // GateServices.initialize(process.env.GATE_API_KEY!, process.env.GATE_API_SECRET!);
  //     const api_key = c.req.header("api-key")!;
  //     const api_secret = c.req.header("api-secret")!;
  //     GateServices.initialize(api_key, api_secret);
  //     const tradeId = c.req.query("trade_id")! as string;
  //     const tpId = c.req.query("tp_id") as string;
  //     const slId = c.req.query("sl_id") as string;
  //     const res1 = await GateServices.cancelFuturesOrder(tradeId);
  //     const res2 = await GateServices.cancelPriceTrigger(tpId);
  //     const res3 = await GateServices.cancelPriceTrigger(slId);
  //     return c.json({ res1, res2, res3 });
  //   } catch (e) {
  //     console.error(e, "ERROR 500 CANCEL POSITION");
  //     if (e instanceof Error) {
  //       return c.json(
  //         {
  //           message: "ERROR!",
  //           error: e.message,
  //         },
  //         { status: 500 },
  //       );
  //     }
  //     return c.json(
  //       {
  //         message: "ERROR!",
  //         error: "UNKNOWN ERROR",
  //       },
  //       { status: 500 },
  //     );
  //   }
  // },

  // getOrderDetails: async function (c: Context) {
  //   try {
  //     // GateServices.initialize(process.env.GATE_API_KEY!, process.env.GATE_API_SECRET!);
  //     const api_key = c.req.header("api-key")!;
  //     const api_secret = c.req.header("api-secret")!;
  //     GateServices.initialize(api_key, api_secret);
  //     const tradeId = c.req.query("trade_id")! as string;
  //     const res = await GateServices.getFuturesOrder(tradeId);
  //     return c.json(res);
  //   } catch (e) {
  //     console.error(e, "ERROR 500 GET ORDER DETAILS");
  //     if (e instanceof Error) {
  //       return c.json(
  //         {
  //           message: "ERROR!",
  //           error: e.message,
  //         },
  //         { status: 500 },
  //       );
  //     }
  //     return c.json(
  //       {
  //         message: "ERROR!",
  //         error: "UNKNOWN ERROR",
  //       },
  //       { status: 500 },
  //     );
  //   }
  // },
  // getAccountDetails: async function (c: Context) {
  //   try {
  //     // GateServices.initialize(process.env.GATE_API_KEY!, process.env.GATE_API_SECRET!);
  //     const api_key = c.req.header("api-key")!;
  //     const api_secret = c.req.header("api-secret")!;
  //     GateServices.initialize(api_key, api_secret);
  //     const accountInfo = await GateServices.getAccountInfo();

  //     const mainKeysInfo = await GateServices.getMainKeysInfo();
  //     return c.json({ accountInfo, mainKeysInfo });
  //   } catch (e) {
  //     console.error(e, "ERROR 500 GET ORDER DETAILS");
  //     if (e instanceof Error) {
  //       return c.json(
  //         {
  //           message: "ERROR!",
  //           error: e.message,
  //         },
  //         { status: 500 },
  //       );
  //     }
  //     return c.json(
  //       {
  //         message: "ERROR!",
  //         error: "UNKNOWN ERROR",
  //       },
  //       { status: 500 },
  //     );
  //   }
  // },

  futuresOrderDb: async function (c: Context) {
    try {
      const body = (await c.req.json()) as z.infer<
        typeof gatePlaceFuturesOrdersSchema
      >;
      let {
        api_key,
        api_secret,
        user_id,
        exchange_user_id,
        encrypted_api_key,
        encrypted_api_secret } =
        await GateHandler.unwrapCredentials(body.exchange_id);
      GateServices.initialize(api_key, api_secret);
      api_key = "";
      api_secret = "";
      const allReturn: { message: string; data: any } = {
        message: "ok",
        data: null,
      };
      console.log("updating leverage");
      // update leverage
      const resLeverage = await GateServices.updateLeverage(
        body.contract,
        body.leverage,
      );
      console.log(resLeverage, "resLeverage");

      // update margin mode
      const resMarginMode = await GateServices.updateMarginMode(
        body.contract,
        body.leverage_type,
      );
      console.log(resMarginMode, "resMarginMode");

      // normalize size sign for entry order (API expects positive to open long, negative to open short)
      let sizeForOrder = body.size;
      if (body.position_type === "short" && sizeForOrder > 0) {
        sizeForOrder = -sizeForOrder;
      }
      let priceStr = body.price.toString();
      let tif = "gtc";
      if (body.market_type === "market") {
        tif = "ioc";
        priceStr = "0";
      }

      const orderPayload: GateFuturesOrder = {
        contract: body.contract,
        size: sizeForOrder,
        price: priceStr,
        tif: tif,
        iceberg: 0,
        reduce_only: body.reduce_only || false,
        auto_size: "",
        settle: "usdt",
      };
      console.log(orderPayload, "orderPayload");
      const resPlaceOrder = await GateServices.placeFuturesOrder(orderPayload);
      console.log(resPlaceOrder, "resPlaceOrder");

      allReturn.data = { resPlaceOrder };

      // Store credentials and trigger WebSocket connection
      await redis.hset(
        `gate:creds:${exchange_user_id}`,
        "apiKey",
        encrypted_api_key,
        "apiSecret",
        encrypted_api_secret,
      );
      await redis.publish(
        "ws-control",
        JSON.stringify({
          op: "open",
          userId: String(exchange_user_id),
          contract: body.contract,
        }),
      );

      // orderType used by both TP and SL blocks
      const orderType = getOrderType(body.position_type);
      const initialPrice = orderType.includes("position") ? "0" : priceStr;

      let autoSize = "close_long";
      if (body.position_type == "short") {
        autoSize = "close_short";
      }

      if (
        resPlaceOrder?.finish_as === "filled" &&
        body.take_profit.enabled &&
        body.market_type === "market"
      ) {
        // directly save current exposure to Redis if
        // order market and successful
        const positionKey = `${resPlaceOrder.contract}:dual_${body.position_type}`;
        await redis.hset(
          `user:${resPlaceOrder?.user}:positions`,
          positionKey,
          JSON.stringify(resPlaceOrder),
        );

        // TRIGGER TP / SL only for market orders
        const payload: GateTriggerPriceOrder = {
          initial: {
            contract: body.contract,
            price: initialPrice,
            tif: tif,
            auto_size: autoSize,
            size: 0,
            reduce_only: true,
          },
          trigger: {
            strategy_type: 0,
            price_type: mapPriceType(body.take_profit.price_type),
            price: body.take_profit.price,
            rule: getTriggerRule(body.position_type, true),
          },
          order_type: body.market_type === "market" ? orderType : undefined,
        };
        console.log(payload, "PAYLOAD TP");
        const resTP = await GateServices.triggerPriceOrder(payload);
        allReturn.data.take_profit = resTP;
      }

      if (
        resPlaceOrder?.finish_as === "filled" &&
        body.stop_loss.enabled &&
        body.market_type === "market"
      ) {
        const payload: GateTriggerPriceOrder = {
          initial: {
            contract: body.contract,
            price: initialPrice,
            tif: tif,
            auto_size: autoSize,
            size: 0,
            reduce_only: true,
          },
          trigger: {
            strategy_type: 0,
            price_type: mapPriceType(body.stop_loss.price_type),
            price: body.stop_loss.price,
            rule: getTriggerRule(body.position_type, false),
          },
          order_type: body.market_type === "market" ? orderType : undefined,
        };
        console.log(payload, "PAYLOAD SL");
        const resSL = await GateServices.triggerPriceOrder(payload);
        allReturn.data.stop_loss = resSL;
      }

      try {
        const tradeStatus = () => {
          if (
            resPlaceOrder?.status === "finished" &&
            resPlaceOrder?.finish_as === "filled" &&
            resPlaceOrder?.left === 0
          )
            return "waiting_targets";
          return resPlaceOrder?.status;
        };
        const addData = {
          user_id: user_id,
          exchange_id: body.exchange_id,
          trade_id: resPlaceOrder.id.toString(),
          open_order_id: resPlaceOrder.id.toString(),

          order_id: resPlaceOrder.id.toString(),
          contract: resPlaceOrder.contract,
          position_type: body.position_type,
          market_type: body.market_type,
          size: resPlaceOrder.size,
          leverage: 10,
          leverage_type: "ISOLATED",
          status: tradeStatus(),
          price: body.price,
          reduce_only: body.reduce_only,
          is_tpsl: false,

          //take profit:
          take_profit_enabled: body.take_profit.enabled,
          take_profit_executed:
            allReturn.data?.take_profit?.status === "open" ? true : false,
          take_profit_price: body.take_profit.enabled
            ? Number(body.take_profit.price)
            : 0,
          take_profit_price_type: body.take_profit.enabled
            ? body.take_profit.price_type
            : "",

          //stop loss:
          stop_loss_enabled: body.stop_loss.enabled,
          stop_loss_executed:
            allReturn.data?.stop_loss?.status === "open" ? true : false,
          stop_loss_price: body.stop_loss.enabled
            ? Number(body.stop_loss.price)
            : 0,
          stop_loss_price_type: body.stop_loss.enabled
            ? body.stop_loss.price_type
            : "",

          metadata: JSON.parse(JSONbig.stringify(resPlaceOrder)),
        };
        console.log(addData, "addData");
        const newTrade = await postgresDb
          .insert(trades)
          .values(addData as any)
          .returning();
        allReturn.data.newTrade = newTrade;
      } catch (err) {
        console.error(err, "ERROR SAVING TO DB");
      }

      return c.json(allReturn);

      // // find trade where user_id, contract, status=finished
      // const resultTradeds = await postgresDb
      //   .select({
      //     trade_id: trades.trade_id,
      //     id: trades.id,
      //     status: trades.status,
      //   })
      //   .from(trades)
      //   .where(and(eq(trades.user_id, 1), eq(trades.contract, "DOGE_USDT")));
      // return c.json(resultTradeds);
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
    } finally {
      GateServices.clearCredentials();
    }
  },
  closePositionDb: async function (c: Context) {
    try {
      // GateServices.initialize(process.env.GATE_API_KEY!, process.env.GATE_API_SECRET!);
      const body = (await c.req.json()) as z.infer<
        typeof closeFuturesPositionSchema
      >;
      const { api_key, api_secret, user_id } =
        await GateHandler.unwrapCredentials(body.exchange_id);
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
  registerUser: async function (c: Context) {
    try {
      const body = (await c.req.json()) as z.infer<
        typeof gateRegisterUserSchema
      >;
      const { user_id } = body;

      let api_key: string | undefined = body.api_key;
      let api_secret: string | undefined = body.api_secret;

      // ---- Validate credentials with Gate BEFORE storing ----
      GateServices.initialize(api_key, api_secret);

      const futuresAccount = await GateServices.whitelistedRequest({
        method: "GET",
        urlPath: "/api/v4/futures/usdt/accounts",
        queryString: "",
        payload: undefined,
      });

      if (futuresAccount.status === "error") {
        return c.json(futuresAccount, { status: futuresAccount.statusCode });
      }

      const account = await GateServices.whitelistedRequest({
        method: "GET",
        urlPath: "/api/v4/account/detail",
        queryString: "",
        payload: undefined,
      });

      if (account.status === "error") {
        return c.json(account, { status: account.statusCode });
      }

      // ---- Encrypt credentials (KMS GenerateDataKey happens here) ----
      const {
        encryptedDEK,
        apiKey: encryptedApiKey,
        apiSecret: encryptedApiSecret,
      } = await generateAndEncryptCredentials(api_key, api_secret);

      // Serialize AES payloads for DB
      const apiKeyCiphertext = JSON.stringify(encryptedApiKey);
      const apiSecretCiphertext = JSON.stringify(encryptedApiSecret);

      // TODO: DELETE BEFORE PUSHING
      const dekResp = await kmsClient.send(
        new DecryptCommand({
          CiphertextBlob: encryptedDEK,
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        }),
      );
      if (!dekResp.Plaintext) throw new Error("KMS decrypt failed");

      const plaintextDEK = Buffer.from(dekResp.Plaintext);

      const decryptedApiKey = decrypt(
        JSON.parse(apiKeyCiphertext),
        plaintextDEK,
      );

      // zero
      plaintextDEK.fill(0);

      // ---- ZERO plaintext ASAP ----
      api_key = undefined;
      api_secret = undefined;

      // ---- Persist encrypted data ----
      const [exchange] = await postgresDb
        .insert(exchanges)
        .values({
          user_id,
          exchange_title: "gate",
          exchange_user_id: account.user_id,
          market_type: "futures",

          api_key_encrypted: apiKeyCiphertext,
          api_secret_encrypted: apiSecretCiphertext,
          enc_dek: encryptedDEK, // BYTEA
        })
        .returning();

      return c.json({
        message: "ok",
        exchange,
      });
    } catch (e) {
      console.error(e, "ERROR REGISTER GATE USER");
      if (e instanceof Error) {
        return c.json({ message: "ERROR!", error: e.message }, { status: 500 });
      }
      return c.json(
        { message: "ERROR!", error: "UNKNOWN ERROR" },
        { status: 500 },
      );
    }
  },

  playground: async function (c: Context) {
    try {
      // GateServices.initialize(process.env.GATE_API_KEY!, process.env.GATE_API_SECRET!);
      const api_key = c.req.header("api-key")!;
      const api_secret = c.req.header("api-secret")!;
      GateServices.initialize(api_key, api_secret);
      const body = (await c.req.json()) as {
        method: string;
        urlPath: string;
        queryString: string;
        payload: any;
      };

      const res = await GateServices.whitelistedRequest({
        method: body.method,
        urlPath: body.urlPath,
        queryString: body.queryString,
        payload: body.payload,
      });

      return c.json(res);
      // return c.json(body);
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
