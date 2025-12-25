import { Hono } from "hono";
import { OkxHandler } from "../handlers/okx/okxHandler";
import { validationErrorHandler } from "../middleware/validationErrorHandler";
import { zValidator } from "@hono/zod-validator";
import { okxRegisterUserSchema } from "../schemas/gateSchemas";

const okxRouter = new Hono();

okxRouter.post("/whitelist-request", OkxHandler.playground);
okxRouter.post(
  "/register-user",
  zValidator("json", okxRegisterUserSchema, validationErrorHandler),
  OkxHandler.registerUser,
);
okxRouter.post(
  "/order",
  OkxHandler.order,
);

export default okxRouter;
