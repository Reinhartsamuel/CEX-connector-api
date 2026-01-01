import * as z from "zod";

// Decimal validation helper - precision 10, scale 2
const decimalRegex = /^\d+(\.\d{1,2})?$/;
const decimalValidation = (fieldName: string) => ({
  message: `${fieldName} must be a decimal number with up to 2 decimal places`,
});

const decimalStringSchema = (fieldName: string) => 
  z.string()
    .regex(decimalRegex, decimalValidation(fieldName))
    .refine(
      (value) => {
        // Check non-negative value
        const num = parseFloat(value);
        return num >= 0;
      },
      { message: `${fieldName} must be greater than or equal to 0` }
    )
    .refine(
      (value) => {
        // Remove decimal point for digit counting
        const numericStr = value.replace('.', '');
        return numericStr.length <= 10; // precision 10
      },
      { message: `${fieldName} must have at most 10 total digits (precision 10)` }
    )
    .refine(
      (value) => {
        // Count decimal places
        const decimalPart = value.split('.')[1];
        return !decimalPart || decimalPart.length <= 2; // scale 2
      },
      { message: `${fieldName} must have at most 2 decimal places (scale 2)` }
    );

// Base autotrader schema without auto-generated fields
const autotraderBaseSchema = z.object({
  user_id: z.number().int().positive(),
  exchange_id: z.number().int().positive(),
  trading_plan_id: z.number(),
  market: z.string().min(1),
  market_code: z.string().optional(),
  pair: z.string().optional(),
  status: z.enum(["active", "paused", "stopped", "error"]).optional(),
  initial_investment: decimalStringSchema("Initial investment"),
  symbol: z.string().min(1),
  position_mode: z.enum(["hedge", "one-way"]),
  margin_mode: z.enum(["isolated", "cross"]),
  leverage: z.number().int().positive(),
  leverage_type: z.enum(["ISOLATED", "CROSS"]).optional(),
  autocompound: z.boolean().default(false),
  current_balance: decimalStringSchema("Current balance").optional(),
});

// Schema for creating a new autotrader
export const createAutotraderSchema = autotraderBaseSchema.extend({
  // No id, created_at, updated_at for creation
});

// Schema for updating an existing autotrader
export const updateAutotraderSchema = z.object({
  user_id: z.number().int().positive().optional(),
  exchange_id: z.number().int().positive().optional(),
  trading_plan_id: z.number().int().positive().optional(),
  market: z.string().min(1).optional(),
  market_code: z.string().optional(),
  pair: z.string().optional(),
  status: z.enum(["active", "paused", "stopped", "error"]).optional(),
  initial_investment: decimalStringSchema("Initial investment").optional(),
  symbol: z.string().min(1).optional(),
  position_mode: z.enum(["hedge", "one-way"]).optional(),
  margin_mode: z.enum(["isolated", "cross"]).optional(),
  leverage: z.number().int().positive().optional(),
  leverage_type: z.enum(["ISOLATED", "CROSS"]).optional(),
  autocompound: z.boolean().optional(),
  current_balance: decimalStringSchema("Current balance").optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: "At least one field must be provided for update" }
);

// Schema for querying/filtering autotraders
export const queryAutotraderSchema = z.object({
  id: z.number().int().positive().optional(),
  user_id: z.number().int().positive().optional(),
  exchange_id: z.number().int().positive().optional(),
  trading_plan_id: z.number().int().positive().optional(),
  market: z.string().optional(),
  market_code: z.string().optional(),
  pair: z.string().optional(),
  status: z.enum(["active", "paused", "stopped", "error"]).optional(),
  symbol: z.string().optional(),
  position_mode: z.enum(["hedge", "one-way"]).optional(),
  margin_mode: z.enum(["isolated", "cross"]).optional(),
  leverage: z.number().int().positive().optional(),
  leverage_type: z.enum(["ISOLATED", "CROSS"]).optional(),
  autocompound: z.boolean().optional(),
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
  sort_by: z.enum([
    "id", "user_id", "exchange_id", "trading_plan_id", 
    "market", "status", "symbol", "created_at", "updated_at"
  ]).default("created_at"),
  sort_order: z.enum(["asc", "desc"]).default("desc"),
});

// Schema for autotrader response (includes all fields)
export const autotraderResponseSchema = z.object({
  id: z.number().int().positive(),
  user_id: z.number().int().positive(),
  exchange_id: z.number().int().positive(),
  trading_plan_id: z.number().int().positive().nullable(),
  market: z.string(),
  market_code: z.string().nullable(),
  pair: z.string().nullable(),
  status: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  initial_investment: z.string(),
  symbol: z.string(),
  position_mode: z.string(),
  margin_mode: z.string(),
  leverage: z.number().int(),
  leverage_type: z.string().nullable(),
  autocompound: z.boolean(),
  current_balance: z.string(),
});

// Schema for batch operations
export const batchAutotraderSchema = z.object({
  autotraders: z.array(createAutotraderSchema).max(100),
});

// Schema for status update
export const updateAutotraderStatusSchema = z.object({
  status: z.enum(["active", "paused", "stopped", "error"]),
});

// Schema for balance update
export const updateAutotraderBalanceSchema = z.object({
  current_balance: decimalStringSchema("Current balance"),
});

// Type exports
export type CreateAutotraderInput = z.infer<typeof createAutotraderSchema>;
export type UpdateAutotraderInput = z.infer<typeof updateAutotraderSchema>;
export type QueryAutotraderInput = z.infer<typeof queryAutotraderSchema>;
export type AutotraderResponse = z.infer<typeof autotraderResponseSchema>;
export type BatchAutotraderInput = z.infer<typeof batchAutotraderSchema>;
export type UpdateAutotraderStatusInput = z.infer<typeof updateAutotraderStatusSchema>;
export type UpdateAutotraderBalanceInput = z.infer<typeof updateAutotraderBalanceSchema>;