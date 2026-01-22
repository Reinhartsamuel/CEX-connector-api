import { Hono } from "hono";
import { TokocryptoHandler } from "../handlers/tokocrypto/tokocryptoHandler";
import { validationErrorHandler } from "../middleware/validationErrorHandler";
import { zValidator } from "@hono/zod-validator";
import {
  tokocryptoRegisterUserSchema,
  tokocryptoPlaceOrderSchema,
  tokocryptoCancelOrderSchema,
  tokocryptoClosePositionSchema,
} from "../schemas/tokocryptoSchemas";

const tokocryptoRouter = new Hono();

tokocryptoRouter.post("/whitelist-request", TokocryptoHandler.playground);

tokocryptoRouter.post(
  "/register-user",
  zValidator("json", tokocryptoRegisterUserSchema, validationErrorHandler),
  TokocryptoHandler.registerUser
);

tokocryptoRouter.post(
  "/order",
  zValidator("json", tokocryptoPlaceOrderSchema, validationErrorHandler),
  TokocryptoHandler.order
);

tokocryptoRouter.post(
  "/cancel-order",
  zValidator("json", tokocryptoCancelOrderSchema, validationErrorHandler),
  TokocryptoHandler.cancelOrder
);

tokocryptoRouter.post(
  "/close-position",
  zValidator("json", tokocryptoClosePositionSchema, validationErrorHandler),
  TokocryptoHandler.closePositionDb
);

export default tokocryptoRouter;
