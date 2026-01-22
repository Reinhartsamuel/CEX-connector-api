import * as z from "zod";

const takeOrStop = z.object({
  enabled: z.boolean(),
  price: z.number().optional(),
  price_type: z.enum(["mark", "last", "index"]).optional(),
});

export const tokocryptoRegisterUserSchema = z.object({
  api_key: z.string(),
  api_secret: z.string(),
  user_id: z.number(),
});

export const tokocryptoPlaceOrderSchema = z.object({
  user_id: z.string(),
  autotrader_id: z.number(),
  exchange_id: z.number(),
  market_type: z.enum(['market', 'limit']),
  price: z.number().optional(),
  contract: z.string(),
  leverage: z.number().nonnegative().gt(0),
  leverage_type: z.enum(['ISOLATED', 'CROSS']),
  size: z.number().nonnegative().gt(0),
  position_type: z.enum(["long", "short"]),
  position_mode: z.enum(['hedge', 'one-way']).default('hedge').optional(), // hedge = can hold long+short, one-way = only one direction
  take_profit: takeOrStop,
  stop_loss: takeOrStop,
  reduce_only: z.boolean().default(false),
  market: z.enum(['spot', 'futures']),
});

export const tokocryptoCancelOrderSchema = z.object({
  exchange_id: z.number(),
  autotrader_id: z.number(),
  contract: z.string(),
});

export const tokocryptoClosePositionSchema = z.object({
  exchange_id: z.number(),
  contract: z.string(),
});
