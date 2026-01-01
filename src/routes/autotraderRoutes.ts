import { Context, Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { validationErrorHandler } from "../middleware/validationErrorHandler";
import { AutotraderHandler } from "../handlers/autotraderHandler";
import {
  createAutotraderSchema,
  updateAutotraderSchema,
  queryAutotraderSchema,
  updateAutotraderStatusSchema,
  updateAutotraderBalanceSchema,
  batchAutotraderSchema,
} from "../schemas/autotraderSchemas";

const autotraderRouter = new Hono();

// Create a new autotrader
autotraderRouter.post(
  "/",
  zValidator("json", createAutotraderSchema, validationErrorHandler),
  AutotraderHandler.create
);

// Batch create autotraders
autotraderRouter.post(
  "/batch",
  zValidator("json", batchAutotraderSchema, validationErrorHandler),
  AutotraderHandler.batchCreate
);

// Get autotrader by ID
autotraderRouter.get("/:id", AutotraderHandler.getById);

// Query autotraders with filters
autotraderRouter.get(
  "/",
  zValidator("query", queryAutotraderSchema, validationErrorHandler),
  AutotraderHandler.query
);

// Update autotrader by ID
autotraderRouter.patch(
  "/:id",
  zValidator("json", updateAutotraderSchema, validationErrorHandler),
  AutotraderHandler.update
);

// Delete autotrader by ID
autotraderRouter.delete("/:id", AutotraderHandler.delete);

// Update autotrader status
autotraderRouter.patch(
  "/:id/status",
  zValidator("json", updateAutotraderStatusSchema, validationErrorHandler),
  AutotraderHandler.updateStatus
);

// Update autotrader balance
autotraderRouter.patch(
  "/:id/balance",
  zValidator("json", updateAutotraderBalanceSchema, validationErrorHandler),
  AutotraderHandler.updateBalance
);

// Get autotrader statistics
autotraderRouter.get("/stats", AutotraderHandler.getStats);

// Health check endpoint for autotraders
autotraderRouter.get("/health", async (c: Context) => {
  return c.json({
    status: "healthy",
    message: "Autotrader routes are working",
    timestamp: new Date().toISOString(),
  });
});

export default autotraderRouter;