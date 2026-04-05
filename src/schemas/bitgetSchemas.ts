import { z } from 'zod';

// Bitget-specific order schema for internal use
export const bitgetOrderSchema = z.object({
  symbol: z.string(),
  size: z.number(),
  price: z.number().optional(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market', 'limit']),
  reduceOnly: z.boolean().optional().default(false),
});

export type BitgetOrder = z.infer<typeof bitgetOrderSchema>;

// Register user request body (Bitget requires passphrase)
export const bitgetRegisterUserSchema = z.object({
  api_key: z.string().min(1, 'API key is required'),
  api_secret: z.string().min(1, 'API secret is required'),
  api_password: z.string().min(1, 'API password/passphrase is required'),
  user_id: z.number(),
});

// Place order schema
export const bitgetPlaceOrderSchema = z.object({
  exchange_id: z.number(),
  autotrader_id: z.number(),
  contract: z.string(),
  position_type: z.enum(['long', 'short']),
  market_type: z.enum(['market', 'limit']),
  size: z.number(),
  price: z.string().optional(),
  leverage: z.number(),
  leverage_type: z.enum(['ISOLATED', 'CROSS']),
  reduce_only: z.boolean().optional().default(false),
});

// Cancel order schema
export const bitgetCancelOrderSchema = z.object({
  exchange_id: z.number(),
  autotrader_id: z.number(),
  contract: z.string(),
});

// Close position schema
export const bitgetClosePositionSchema = z.object({
  exchange_id: z.number(),
  contract: z.string(),
});

// Connect account schema
export const bitgetConnectSchema = z.object({
  exchange_user_id: z.string().optional(),
});
