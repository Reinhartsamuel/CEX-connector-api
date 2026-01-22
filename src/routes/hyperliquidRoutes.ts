import { Context, Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { validationErrorHandler } from "../middleware/validationErrorHandler";
// Using your existing futures schema for consistency
import { gatePlaceFuturesOrdersSchema } from "../schemas/gateSchemas";
import { HyperliquidHandler } from "../handlers/hyperliquid/hyperliquidHandler";

const hyperliquidRouter = new Hono();

/**
 * 1. Register User (Agent Wallet Flow)
 * Expects: { wallet_address, private_key, user_id }
 */
hyperliquidRouter.post(
  "/register-user",
  // You might want to create a specific hyperliquidRegisterSchema,
  // but for now, we'll keep it flexible or use validationErrorHandler
  HyperliquidHandler.registerUser
);

/**
 * 2. Place Futures Order
 * Uses the Agent wallet to sign orders on Hyperliquid L1
 */
hyperliquidRouter.post(
  "/place-futures-order",
  zValidator("json", gatePlaceFuturesOrdersSchema, validationErrorHandler),
  HyperliquidHandler.order
);

/**
 * 3. Cancel Order
 * Cancels resting orders for a specific contract/autotrader
 */
hyperliquidRouter.post(
  "/cancel-order",
  HyperliquidHandler.cancelOrder
);

/**
 * 4. Close Position
 * Reduces position to zero via Market order
 */
hyperliquidRouter.post(
  "/close-futures-position",
  HyperliquidHandler.closePositionDb
);

/**
 * 5. Whitelist Request (Playground)
 * Allows raw /info or /exchange calls via headers
 */
hyperliquidRouter.post(
  "/whitelist-request",
  HyperliquidHandler.playground
);

/**
 * Utility Route: Check Account State
 * Useful for debugging if the Agent is correctly authorized
 */
hyperliquidRouter.get("/account/:address", async (c: Context) => {
  const address = c.req.param("address");
  try {
    const { HyperliquidServices } = await import("../services/hyperliquidServices");
    const state = await HyperliquidServices.whitelistedRequest({
      method: "POST",
      requestPath: "/info",
      payloadString: JSON.stringify({ type: "clearinghouseState", user: address })
    });
    return c.json(state);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

export default hyperliquidRouter;
