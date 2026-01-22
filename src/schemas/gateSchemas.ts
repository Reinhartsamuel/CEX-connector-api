import * as z from "zod";

const takeOrStop = z.object({
  enabled: z.boolean(),
  price: z.string().optional(),
  price_type: z.enum(['mark', 'index', 'last']).optional(),
}).refine((data) => {
  // If enabled is true, price and price_type MUST exist
  if (data.enabled) {
    return !!data.price && !!data.price_type;
  }
  // If enabled is false, it doesn't matter if they are missing
  return true;
}, {
  message: "Price and Price Type are required when enabled is true",
  path: ["price"], // This points the error to the price field
});
export const gatePlaceFuturesOrdersSchema = z.object({
  user_id: z.string(),
  autotrader_id:z.number(),
  exchange_id: z.number(),
  market_type: z.enum(['market', 'limit']),
  price: z.float64(),
  contract: z.string(),
  leverage: z.number().nonnegative().gt(0),
  leverage_type: z.enum(['ISOLATED', 'CROSS']),
  size: z.number().nonnegative().gt(0),
  position_type: z.enum(["long","short"]),
  take_profit: takeOrStop,
  stop_loss: takeOrStop,
  reduce_only:z.boolean()
});

export const closeFuturesPositionSchema = z.object({
  contract: z.string(),
  auto_size: z.enum(["close_long","close_short"]),
  exchange_id: z.number()
});

export const gateRegisterUserSchema = z.object({
  api_key: z.string(),
  api_secret: z.string(),
  user_id: z.number()
});


// Add more gate-related schemas here as needed
// export const otherGateSchema = z.object({
//   // schema definition
// });
