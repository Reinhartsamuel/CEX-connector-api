import { Context } from "hono";
import { GateServices } from "../../services/gateServices";
import {
  GateFuturesOrder,
  GateTriggerPriceOrder,
} from "../../schemas/interfaces";
import {
  closeFuturesPositionSchema,
  placeFuturesOrdersSchema,
} from "../../schemas/gateSchemas";
import * as z from "zod";

export const GateHandler = {
  order: async function (c: Context) {
    try {
      const body = (await c.req.json()) as z.infer<
        typeof placeFuturesOrdersSchema
      >;
      // GateServices.initialize(process.env.GATE_API_KEY!, process.env.GATE_SECRET_KEY!);
      const api_key = c.req.header('api-key')!;
      const api_secret = c.req.header('api-secret')!;
      GateServices.initialize(
        api_key,
        api_secret
      );
      let allReturn: { message: string; data: any } = {
        message: "ok",
        data: null,
      };

      if (body.leverage != 1) {
        console.log("updating leverage");
        // update leverage
        const resLeverage = await GateServices.updateLeverage(
          body.contract,
          body.leverage,
        );
        console.log(resLeverage, "resLeverage");
      }

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
        reduce_only: false,
        auto_size: "",
        settle: "usdt",
        take_profit: body.take_profit.price,
        stop_loss: body.stop_loss.price,
      };
      console.log(orderPayload, "orderPayload");
      const resPlaceOrder = await GateServices.placeFuturesOrder(orderPayload);
      console.log(resPlaceOrder, "resPlaceOrder");
      allReturn.data = { resPlaceOrder };

      // --- helpers ---
      const getOrderType = function (
        positionType: string,
        marketType: string,
      ): string {
        // For market entries the position exists immediately -> use position-level close
        // For limit entries the order may be unfilled -> attach to order
        if (positionType == "long") {
          if (marketType == "market") {
            return "close-long-position";
          }
          return "close-long-order";
        }
        // short
        if (marketType == "market") {
          return "close-short-position";
        }
        return "close-short-order";
      };

      const getTriggerRule = function (
        positionType: "long" | "short",
        isTakeProfit: boolean,
      ): number {
        // 1 => trigger when price >= trigger_price
        // 2 => trigger when price <= trigger_price
        if (isTakeProfit) {
          if (positionType == "long") {
            return 1; // long TP: price rises to or above target
          }
          return 2; // short TP: price falls to or below target
        }
        // stop loss
        if (positionType == "long") {
          return 2; // long SL: price falls to or below target
        }
        return 1; // short SL: price rises to or above target
      };

      const mapPriceType = function (s: "mark" | "last" | "index"): number {
        switch (s) {
          case "last":
            return 0;
          case "mark":
            return 1;
          case "index":
            return 2;
          default:
            return 0;
        }
      };

      // orderType used by both TP and SL blocks
      const orderType = getOrderType(body.position_type, body.market_type);
      console.log(orderType, "orderType");
      let initialPrice = orderType.includes("position") ? "0" : priceStr;

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
          // order_type: orderType,
        };
        console.log(payload, "PAYLOAD TP");
        const resTP = await GateServices.triggerPriceOrder(payload);
        allReturn.data.take_profit = resTP
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
          // order_type: orderType,
        };
        console.log(payload, "PAYLOAD SL");
        const resSL = await GateServices.triggerPriceOrder(payload);
        allReturn.data.stop_loss = resSL;
      }

      return c.json(allReturn);
    } catch (e) {
      console.error(e, "kuda rawrrrr");
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
  closePosition: async function (c: Context) {
    try {
      // GateServices.initialize(process.env.GATE_API_KEY!, process.env.GATE_SECRET_KEY!);
      const body = await c.req.json() as z.infer<typeof closeFuturesPositionSchema>;
      const api_key = c.req.header('api-key')!;
      const api_secret = c.req.header('api-secret')!;
      GateServices.initialize(
        api_key,
        api_secret
      );
      const res = await GateServices.closeFuturesOrder(body);
      return c.json(res);
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

  cancelPosition: async function (c: Context) {
    try {
      // GateServices.initialize(process.env.GATE_API_KEY!, process.env.GATE_SECRET_KEY!);
      const api_key = c.req.header('api-key')!;
      const api_secret = c.req.header('api-secret')!;
      GateServices.initialize(
        api_key,
        api_secret
      );
      const tradeId = c.req.query('trade_id')! as string;
      const tpId = c.req.query('tp_id') as string;
      const slId = c.req.query('sl_id') as string;
      const res1 = await GateServices.cancelFuturesOrder(tradeId);
      const res2 = await GateServices.cancelPriceTrigger(tpId);
      const res3 = await GateServices.cancelPriceTrigger(slId);
      return c.json({res1, res2, res3});
    } catch (e) {
      console.error(e, "ERROR 500 CANCEL POSITION");
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
  getOrderDetails: async function (c: Context) {
    try {
      // GateServices.initialize(process.env.GATE_API_KEY!, process.env.GATE_SECRET_KEY!);
      const api_key = c.req.header('api-key')!;
      const api_secret = c.req.header('api-secret')!;
      GateServices.initialize(
        api_key,
        api_secret
      );
      const tradeId = c.req.query('trade_id')! as string;
      const res = await GateServices.getFuturesOrder(tradeId);
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
