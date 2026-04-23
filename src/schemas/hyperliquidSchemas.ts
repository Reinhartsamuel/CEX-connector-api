import * as z from "zod";

export const hyperliquidRegisterUserSchema = z.object({
  api_key: z.string(),
  api_secret: z.string(),
  user_id: z.number()
});


export const hyperliquidPlaceFuturesOrdersSchema = z.object({

});
