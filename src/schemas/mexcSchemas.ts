import { z } from 'zod';

// MEXC-specific order schema for internal use
export const mexcOrderSchema = z.object({
  symbol: z.string(),
  size: z.number(),
  price: z.number().optional(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market', 'limit']),
  reduceOnly: z.boolean().optional().default(false),
});

export type MexcOrder = z.infer<typeof mexcOrderSchema>;

// Register user request body (MEXC does NOT require passphrase)
export const mexcRegisterUserSchema = z.object({
  api_key: z.string().min(1, 'API key is required'),
  api_secret: z.string().min(1, 'API secret is required'),
  user_id: z.number(),
});

// Place order schema
export const mexcPlaceOrderSchema = z.object({
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
export const mexcCancelOrderSchema = z.object({
  exchange_id: z.number(),
  autotrader_id: z.number(),
  contract: z.string(),
});

// Close position schema
export const mexcClosePositionSchema = z.object({
  exchange_id: z.number(),
  contract: z.string(),
});

// Connect account schema
export const mexcConnectSchema = z.object({
  exchange_user_id: z.string().optional(),
});
