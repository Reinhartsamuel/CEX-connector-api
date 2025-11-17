import { Hono } from "hono";
import { GateHandler } from "../handlers/gate/gate_handler";
import { zValidator } from "@hono/zod-validator";
import { validationErrorHandler } from "../middleware/validationErrorHandler";
import { placeFuturesOrdersSchema } from "../schemas/gateSchemas";

const gateRouter = new Hono();

gateRouter.post(
  "/place-futures-order",
  zValidator("json", placeFuturesOrdersSchema, validationErrorHandler),
  GateHandler.order,
);

gateRouter.post(
  "/close-futures-order",
  GateHandler.closePosition,
);

gateRouter.delete(
  "/cancel-futures-order",
  GateHandler.cancelPosition,
);

gateRouter.get(
  "/get-futures-order",
  GateHandler.getOrderDetails,
);

export default gateRouter;
