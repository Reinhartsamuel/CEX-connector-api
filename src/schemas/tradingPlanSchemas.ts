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



// Base trading plan schema without auto-generated fields
const tradingPlanBaseSchema = z.object({
  owner_user_id: z.number().int().positive(),
  name: z.string().min(1).max(255),
  description: z.string().min(1),
  total_followers: z.number().int().nonnegative().default(0),
  is_active: z.boolean().default(false),
});

// Schema for creating a new trading plan
export const createTradingPlanSchema = tradingPlanBaseSchema.extend({
  // No id, created_at for creation
});

// Schema for updating an existing trading plan
export const updateTradingPlanSchema = z.object({
  owner_user_id: z.number().int().positive().optional(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().min(1).optional(),
  strategy: z.string().min(1).optional(),
  parameters: z.any().optional(),
  visibility: z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]).optional(),
  total_followers: z.number().int().nonnegative().optional(),
  pnl_30d: decimalStringSchema("PNL 30d").optional(),
  max_dd: decimalStringSchema("Maximum drawdown").optional(),
  sharpe: decimalStringSchema("Sharpe ratio").optional(),
  is_active: z.boolean().optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: "At least one field must be provided for update" }
);

// Schema for querying/filtering trading plans
export const queryTradingPlanSchema = z.object({
  id: z.number().int().positive().optional(),
  owner_user_id: z.number().int().positive().optional(),
  name: z.string().optional(),
  strategy: z.string().optional(),
  visibility: z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]).optional(),
  is_active: z.boolean().optional(),
  min_pnl_30d: decimalStringSchema("Minimum PNL 30d").optional(),
  max_pnl_30d: decimalStringSchema("Maximum PNL 30d").optional(),
  min_sharpe: decimalStringSchema("Minimum Sharpe ratio").optional(),
  max_sharpe: decimalStringSchema("Maximum Sharpe ratio").optional(),
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
  sort_by: z.enum([
    "id", "owner_user_id", "name", "visibility", "pnl_30d",
    "sharpe", "total_followers", "created_at", "is_active"
  ]).default("created_at"),
  sort_order: z.enum(["asc", "desc"]).default("desc"),
});

// Schema for trading plan response (includes all fields)
export const tradingPlanResponseSchema = z.object({
  id: z.number().int().positive(),
  owner_user_id: z.number().int().positive(),
  name: z.string(),
  description: z.string(),
  strategy: z.string(),
  parameters: z.any(),
  visibility: z.string(),
  total_followers: z.number().int(),
  pnl_30d: z.string(),
  max_dd: z.string(),
  sharpe: z.string(),
  created_at: z.string().datetime(),
  is_active: z.boolean(),
});

// Schema for batch operations
export const batchTradingPlanSchema = z.object({
  trading_plans: z.array(createTradingPlanSchema).max(100),
});

// Schema for status update
export const updateTradingPlanStatusSchema = z.object({
  is_active: z.boolean(),
});

// Schema for visibility update
export const updateTradingPlanVisibilitySchema = z.object({
  visibility: z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]),
});

// Schema for metrics update
export const updateTradingPlanMetricsSchema = z.object({
  pnl_30d: decimalStringSchema("PNL 30d"),
  max_dd: decimalStringSchema("Maximum drawdown"),
  sharpe: decimalStringSchema("Sharpe ratio"),
});

// Schema for follower count update
export const updateTradingPlanFollowersSchema = z.object({
  total_followers: z.number().int().nonnegative(),
});

// Trading plan pair schemas
const tradingPlanPairBaseSchema = z.object({
  trading_plan_id: z.number().int().positive(),
  base_asset: z.string().min(1).max(50),
  quote_asset: z.string().min(1).max(50),
  symbol: z.string().min(1).max(100),
});

// Schema for creating a new trading plan pair
export const createTradingPlanPairSchema = tradingPlanPairBaseSchema;

// Schema for updating an existing trading plan pair
export const updateTradingPlanPairSchema = z.object({
  trading_plan_id: z.number().int().positive().optional(),
  base_asset: z.string().min(1).max(50).optional(),
  quote_asset: z.string().min(1).max(50).optional(),
  symbol: z.string().min(1).max(100).optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: "At least one field must be provided for update" }
);

// Schema for querying/filtering trading plan pairs
export const queryTradingPlanPairSchema = z.object({
  id: z.number().int().positive().optional(),
  trading_plan_id: z.number().int().positive().optional(),
  base_asset: z.string().optional(),
  quote_asset: z.string().optional(),
  symbol: z.string().optional(),
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
  sort_by: z.enum(["id", "trading_plan_id", "symbol", "base_asset", "quote_asset"]).default("id"),
  sort_order: z.enum(["asc", "desc"]).default("asc"),
});

// Schema for trading plan pair response
export const tradingPlanPairResponseSchema = z.object({
  id: z.number().int().positive(),
  trading_plan_id: z.number().int().positive(),
  base_asset: z.string(),
  quote_asset: z.string(),
  symbol: z.string(),
});

// Schema for batch trading plan pairs
export const batchTradingPlanPairSchema = z.object({
  trading_plan_pairs: z.array(createTradingPlanPairSchema).max(100),
});

// Type exports for trading plans
export type CreateTradingPlanInput = z.infer<typeof createTradingPlanSchema>;
export type UpdateTradingPlanInput = z.infer<typeof updateTradingPlanSchema>;
export type QueryTradingPlanInput = z.infer<typeof queryTradingPlanSchema>;
export type TradingPlanResponse = z.infer<typeof tradingPlanResponseSchema>;
export type BatchTradingPlanInput = z.infer<typeof batchTradingPlanSchema>;
export type UpdateTradingPlanStatusInput = z.infer<typeof updateTradingPlanStatusSchema>;
export type UpdateTradingPlanVisibilityInput = z.infer<typeof updateTradingPlanVisibilitySchema>;
export type UpdateTradingPlanMetricsInput = z.infer<typeof updateTradingPlanMetricsSchema>;
export type UpdateTradingPlanFollowersInput = z.infer<typeof updateTradingPlanFollowersSchema>;

// Type exports for trading plan pairs
export type CreateTradingPlanPairInput = z.infer<typeof createTradingPlanPairSchema>;
export type UpdateTradingPlanPairInput = z.infer<typeof updateTradingPlanPairSchema>;
export type QueryTradingPlanPairInput = z.infer<typeof queryTradingPlanPairSchema>;
export type TradingPlanPairResponse = z.infer<typeof tradingPlanPairResponseSchema>;
export type BatchTradingPlanPairInput = z.infer<typeof batchTradingPlanPairSchema>;
