import * as z from "zod";

export const okxRegisterUserSchema = z.object({
  api_key: z.string(),
  api_secret: z.string(),
  api_passphrase: z.string(),
  user_id: z.number()
});


export const okxCancelOrderSchema = z.object({
  exchange_id:z.number(),
  autotrader_id: z.number(),
  contract: z.string(),
});
