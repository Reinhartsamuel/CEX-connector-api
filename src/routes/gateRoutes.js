import { Hono } from "hono";
import { GateHandler } from "../handlers/gate/gate_handler";
import { zValidator } from "@hono/zod-validator";
import { validationErrorHandler } from "../middleware/validationErrorHandler";
import { placeFuturesOrdersSchema } from "../schemas/gateSchemas";
import { getAll } from "../utils/cache";
const gateRouter = new Hono();
gateRouter.post("/place-futures-order", zValidator("json", placeFuturesOrdersSchema, validationErrorHandler), GateHandler.futuresOrder);
gateRouter.post("/place-futures-order-x", zValidator("json", placeFuturesOrdersSchema, validationErrorHandler), GateHandler.futuresOrderDb);
gateRouter.post("/close-futures-order-x", GateHandler.closePositionDb);
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
gateRouter.get(async function (c) {
    // del('trade:56013524483295954');
    // clear()
    const testGet = getAll();
    return c.json({
        message: 'oke',
        testGet
    });
});
export default gateRouter;
