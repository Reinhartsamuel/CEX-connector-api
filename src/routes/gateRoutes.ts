import { Context, Hono } from "hono";

import { zValidator } from "@hono/zod-validator";
import { validationErrorHandler } from "../middleware/validationErrorHandler";
import { gateRegisterUserSchema, gatePlaceFuturesOrdersSchema } from "../schemas/gateSchemas";
import { postgresDb } from "../db/client";
import { exchanges, trades } from "../db/schema";
import { and, eq } from "drizzle-orm";
import redis from "../db/redis";
import { GateHandler } from "../handlers/gate/gateHandler";

const gateRouter = new Hono();

gateRouter.post(
  "/place-futures-order",
  zValidator("json", gatePlaceFuturesOrdersSchema, validationErrorHandler),
  GateHandler.futuresOrder,
);
gateRouter.post(
  "/place-futures-order-x",
  zValidator("json", gatePlaceFuturesOrdersSchema, validationErrorHandler),
  GateHandler.futuresOrderDb,
);
gateRouter.post("/close-futures-order-x", GateHandler.closePositionDb);

gateRouter.post("/register-user",zValidator("json", gateRegisterUserSchema, validationErrorHandler), GateHandler.registerUser);
// gateRouter.post(
//   "/close-futures-order",
//   GateHandler.closePosition,
// );

// gateRouter.delete(
//   "/cancel-futures-order",
//   GateHandler.cancelPosition,
// );

// gateRouter.get(
//   "/get-futures-order",
//   GateHandler.getOrderDetails,
// );
// gateRouter.get(
//   "/account-info",
//   GateHandler.getAccountDetails
// );
gateRouter.post("/whitelist-request", GateHandler.playground);
gateRouter.get('/kuda', async function (c: Context) {
  // const trade = await postgresDb.query.trades.findFirst({
  //   where: eq(trades.size, "-1")
  // });

  // const exchange = await postgresDb.query.exchanges.findFirst({
  //   columns: {
  //     id: true,  // Only select the id column
  //   },
  //   where:eq(exchanges.exchange_user_id, '16778193'),
  //   });

  // const trade = await postgresDb.query.trades.findFirst({
  //   columns: {
  //     id: true,  // Only select the id column
  //   },
  //   where: and(
  //     eq(trades.status, 'waiting_targets'),
  //     eq(trades.contract, 'DOGE_USDT'),
  //     eq(trades.exchange_id, exchange!.id),
  //     // We need to join with exchanges table to filter by exchange_user_id
  //     // This requires using a subquery or join
  //   )
  // });

    const prevRaw = await redis.hget(`user:16778193:positions`, 'DOGE_USDT:dual_short');
    const prev = prevRaw ? JSON.parse(prevRaw) : undefined;
  return c.json({
    message: "oke",
    prev
  });
});

export default gateRouter;
