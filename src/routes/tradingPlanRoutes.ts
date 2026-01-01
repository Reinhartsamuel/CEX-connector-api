import { Context, Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { validationErrorHandler } from "../middleware/validationErrorHandler";
import { TradingPlanHandler } from "../handlers/tradingPlanHandler";
import {
  batchTradingPlanSchema,
  createTradingPlanSchema,
  updateTradingPlanSchema,
  queryTradingPlanSchema,
  updateTradingPlanStatusSchema,
  updateTradingPlanVisibilitySchema,
  updateTradingPlanMetricsSchema,
  updateTradingPlanFollowersSchema,
  createTradingPlanPairSchema,
  updateTradingPlanPairSchema,
  queryTradingPlanPairSchema,
  batchTradingPlanPairSchema
} from "../schemas/tradingPlanSchemas";

const tradingPlanRouter = new Hono();

// ========== TRADING PLANS ROUTES ==========

// Create a new trading plan
tradingPlanRouter.post(
  "/",
  zValidator("json", createTradingPlanSchema, validationErrorHandler),
  TradingPlanHandler.createTradingPlan,
);

// Batch create trading plans
tradingPlanRouter.post(
  "/batch",
  zValidator("json", batchTradingPlanSchema, validationErrorHandler),
  TradingPlanHandler.batchCreateTradingPlans,
);

// Get trading plan by ID
tradingPlanRouter.get("/:id", TradingPlanHandler.getTradingPlanById);

// Query trading plans with filters
tradingPlanRouter.get(
  "/",
  zValidator("query", queryTradingPlanSchema, validationErrorHandler),
  TradingPlanHandler.queryTradingPlans,
);

// Update trading plan by ID
tradingPlanRouter.patch(
  "/:id",
  zValidator("json", updateTradingPlanSchema, validationErrorHandler),
  TradingPlanHandler.updateTradingPlan,
);

// Delete trading plan by ID
tradingPlanRouter.delete("/:id", TradingPlanHandler.deleteTradingPlan);

// Update trading plan status
tradingPlanRouter.patch(
  "/:id/status",
  zValidator("json", updateTradingPlanStatusSchema, validationErrorHandler),
  TradingPlanHandler.updateTradingPlanStatus,
);

// Update trading plan visibility
tradingPlanRouter.patch(
  "/:id/visibility",
  zValidator("json", updateTradingPlanVisibilitySchema, validationErrorHandler),
  TradingPlanHandler.updateTradingPlanVisibility,
);

// Update trading plan metrics
tradingPlanRouter.patch(
  "/:id/metrics",
  zValidator("json", updateTradingPlanMetricsSchema, validationErrorHandler),
  TradingPlanHandler.updateTradingPlanMetrics,
);

// Update trading plan followers
tradingPlanRouter.patch(
  "/:id/followers",
  zValidator("json", updateTradingPlanFollowersSchema, validationErrorHandler),
  TradingPlanHandler.updateTradingPlanFollowers,
);

// Get trading plan statistics
tradingPlanRouter.get("/stats", TradingPlanHandler.getTradingPlanStats);

// Get trading plan with its pairs
tradingPlanRouter.get(
  "/:id/with-pairs",
  TradingPlanHandler.getTradingPlanWithPairs,
);

// ========== TRADING PLAN PAIRS ROUTES ==========

// Create a new trading plan pair
tradingPlanRouter.post(
  "/pairs",
  zValidator("json", createTradingPlanPairSchema, validationErrorHandler),
  TradingPlanHandler.createTradingPlanPair,
);

// Batch create trading plan pairs
tradingPlanRouter.post(
  "/pairs/batch",
  zValidator("json", batchTradingPlanPairSchema, validationErrorHandler),
  TradingPlanHandler.batchCreateTradingPlanPairs,
);

// Get trading plan pair by ID
tradingPlanRouter.get("/pairs/:id", TradingPlanHandler.getTradingPlanPairById);

// Query trading plan pairs with filters
tradingPlanRouter.get(
  "/pairs",
  zValidator("query", queryTradingPlanPairSchema, validationErrorHandler),
  TradingPlanHandler.queryTradingPlanPairs,
);

// Update trading plan pair by ID
tradingPlanRouter.patch(
  "/pairs/:id",
  zValidator("json", updateTradingPlanPairSchema, validationErrorHandler),
  TradingPlanHandler.updateTradingPlanPair,
);

// Delete trading plan pair by ID
tradingPlanRouter.delete(
  "/pairs/:id",
  TradingPlanHandler.deleteTradingPlanPair,
);

// Get trading plan pairs by trading plan ID
tradingPlanRouter.get(
  "/:trading_plan_id/pairs",
  TradingPlanHandler.getPairsByTradingPlanId,
);

// ========== HEALTH CHECK ==========

// Health check endpoint for trading plans
tradingPlanRouter.get("/health", async (c: Context) => {
  return c.json({
    status: "healthy",
    message: "Trading plan routes are working",
    timestamp: new Date().toISOString(),
  });
});

export default tradingPlanRouter;
