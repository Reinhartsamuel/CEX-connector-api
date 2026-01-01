import { Context } from "hono";
import { postgresDb } from "../db/client";
import { trading_plans, trading_plan_pairs, users } from "../db/schema";
import { and, eq, desc, asc, inArray, sql } from "drizzle-orm";
import {
  createTradingPlanSchema,
  updateTradingPlanSchema,
  queryTradingPlanSchema,
  updateTradingPlanStatusSchema,
  updateTradingPlanVisibilitySchema,
  updateTradingPlanMetricsSchema,
  updateTradingPlanFollowersSchema,
  batchTradingPlanSchema,
  createTradingPlanPairSchema,
  updateTradingPlanPairSchema,
  queryTradingPlanPairSchema,
  batchTradingPlanPairSchema,
} from "../schemas/tradingPlanSchemas";

export const TradingPlanHandler = {
  // ========== TRADING PLANS CRUD ==========

  // Create a new trading plan
  createTradingPlan: async function (c: Context) {
    try {
      const body = await c.req.json();
      const validatedData = createTradingPlanSchema.parse(body);

      // Check if owner user exists
      const userExists = await postgresDb
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, validatedData.owner_user_id))
        .limit(1);

      if (userExists.length === 0) {
        return c.json(
          {
            message: "User not found",
            error: `User with ID ${validatedData.owner_user_id} does not exist`,
          },
          404
        );
      }

      // Create the trading plan
      const [newTradingPlan] = await postgresDb
        .insert(trading_plans)
        .values(validatedData)
        .returning();

      return c.json(
        {
          message: "Trading plan created successfully",
          data: newTradingPlan,
        },
        201
      );
    } catch (error: any) {
      console.error("Error creating trading plan:", error);

      if (error.name === "ZodError") {
        return c.json(
          {
            message: "Validation error",
            error: error.errors,
          },
          400
        );
      }

      return c.json(
        {
          message: "Failed to create trading plan",
          error: error.message,
        },
        500
      );
    }
  },

  // Get trading plan by ID
  getTradingPlanById: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid trading plan ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      const tradingPlan = await postgresDb
        .select()
        .from(trading_plans)
        .where(eq(trading_plans.id, id))
        .limit(1);

      if (tradingPlan.length === 0) {
        return c.json(
          {
            message: "Trading plan not found",
            error: `Trading plan with ID ${id} does not exist`,
          },
          404
        );
      }

      return c.json({
        message: "Trading plan retrieved successfully",
        data: tradingPlan[0],
      });
    } catch (error: any) {
      console.error("Error getting trading plan:", error);
      return c.json(
        {
          message: "Failed to retrieve trading plan",
          error: error.message,
        },
        500
      );
    }
  },

  // Query trading plans with filters
  queryTradingPlans: async function (c: Context) {
    try {
      const queryParams = c.req.query();
      const validatedQuery = queryTradingPlanSchema.parse({
        ...queryParams,
        id: queryParams.id ? parseInt(queryParams.id) : undefined,
        owner_user_id: queryParams.owner_user_id ? parseInt(queryParams.owner_user_id) : undefined,
        total_followers: queryParams.total_followers ? parseInt(queryParams.total_followers) : undefined,
        is_active: queryParams.is_active ? queryParams.is_active === "true" : undefined,
        limit: queryParams.limit ? parseInt(queryParams.limit) : undefined,
        offset: queryParams.offset ? parseInt(queryParams.offset) : undefined,
      });

      // Build where conditions
      const conditions = [];

      if (validatedQuery.id) conditions.push(eq(trading_plans.id, validatedQuery.id));
      if (validatedQuery.owner_user_id) conditions.push(eq(trading_plans.owner_user_id, validatedQuery.owner_user_id));
      if (validatedQuery.name) conditions.push(sql`${trading_plans.name} ILIKE ${`%${validatedQuery.name}%`}`);
      if (validatedQuery.strategy) conditions.push(sql`${trading_plans.strategy} ILIKE ${`%${validatedQuery.strategy}%`}`);
      if (validatedQuery.visibility) conditions.push(eq(trading_plans.visibility, validatedQuery.visibility));
      if (validatedQuery.is_active !== undefined) conditions.push(eq(trading_plans.is_active, validatedQuery.is_active));
      if (validatedQuery.min_pnl_30d) conditions.push(sql`${trading_plans.pnl_30d}::numeric >= ${validatedQuery.min_pnl_30d}::numeric`);
      if (validatedQuery.max_pnl_30d) conditions.push(sql`${trading_plans.pnl_30d}::numeric <= ${validatedQuery.max_pnl_30d}::numeric`);
      if (validatedQuery.min_sharpe) conditions.push(sql`${trading_plans.sharpe}::numeric >= ${validatedQuery.min_sharpe}::numeric`);
      if (validatedQuery.max_sharpe) conditions.push(sql`${trading_plans.sharpe}::numeric <= ${validatedQuery.max_sharpe}::numeric`);

      // Build order by
      const orderBy = validatedQuery.sort_order === "desc"
        ? desc(trading_plans[validatedQuery.sort_by as keyof typeof trading_plans.$inferSelect])
        : asc(trading_plans[validatedQuery.sort_by as keyof typeof trading_plans.$inferSelect]);

      // Execute query
      const results = await postgresDb
        .select()
        .from(trading_plans)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(orderBy)
        .limit(validatedQuery.limit)
        .offset(validatedQuery.offset);

      // Get total count for pagination
      const totalResult = await postgresDb
        .select({ count: sql<number>`count(*)` })
        .from(trading_plans)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      const total = totalResult[0]?.count || 0;

      return c.json({
        message: "Trading plans retrieved successfully",
        data: results,
        pagination: {
          total,
          limit: validatedQuery.limit,
          offset: validatedQuery.offset,
          has_more: validatedQuery.offset + validatedQuery.limit < total,
        },
      });
    } catch (error: any) {
      console.error("Error querying trading plans:", error);

      if (error.name === "ZodError") {
        return c.json(
          {
            message: "Validation error",
            error: error.errors,
          },
          400
        );
      }

      return c.json(
        {
          message: "Failed to query trading plans",
          error: error.message,
        },
        500
      );
    }
  },

  // Update trading plan by ID
  updateTradingPlan: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid trading plan ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      const body = await c.req.json();
      const validatedData = updateTradingPlanSchema.parse(body);

      // Check if trading plan exists
      const existingTradingPlan = await postgresDb
        .select({ id: trading_plans.id })
        .from(trading_plans)
        .where(eq(trading_plans.id, id))
        .limit(1);

      if (existingTradingPlan.length === 0) {
        return c.json(
          {
            message: "Trading plan not found",
            error: `Trading plan with ID ${id} does not exist`,
          },
          404
        );
      }

      // Validate owner user if provided
      if (validatedData.owner_user_id !== undefined) {
        const userExists = await postgresDb
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, validatedData.owner_user_id))
          .limit(1);

        if (userExists.length === 0) {
          return c.json(
            {
              message: "User not found",
              error: `User with ID ${validatedData.owner_user_id} does not exist`,
            },
            404
          );
        }
      }

      // Update the trading plan
      const [updatedTradingPlan] = await postgresDb
        .update(trading_plans)
        .set({
          ...validatedData,
        })
        .where(eq(trading_plans.id, id))
        .returning();

      return c.json({
        message: "Trading plan updated successfully",
        data: updatedTradingPlan,
      });
    } catch (error: any) {
      console.error("Error updating trading plan:", error);

      if (error.name === "ZodError") {
        return c.json(
          {
            message: "Validation error",
            error: error.errors,
          },
          400
        );
      }

      return c.json(
        {
          message: "Failed to update trading plan",
          error: error.message,
        },
        500
      );
    }
  },

  // Delete trading plan by ID
  deleteTradingPlan: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid trading plan ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      // Check if trading plan exists
      const existingTradingPlan = await postgresDb
        .select({ id: trading_plans.id })
        .from(trading_plans)
        .where(eq(trading_plans.id, id))
        .limit(1);

      if (existingTradingPlan.length === 0) {
        return c.json(
          {
            message: "Trading plan not found",
            error: `Trading plan with ID ${id} does not exist`,
          },
          404
        );
      }

      // Delete the trading plan (cascade will delete associated pairs)
      await postgresDb
        .delete(trading_plans)
        .where(eq(trading_plans.id, id));

      return c.json({
        message: "Trading plan deleted successfully",
        data: { id },
      });
    } catch (error: any) {
      console.error("Error deleting trading plan:", error);
      return c.json(
        {
          message: "Failed to delete trading plan",
          error: error.message,
        },
        500
      );
    }
  },

  // Update trading plan status
  updateTradingPlanStatus: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid trading plan ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      const body = await c.req.json();
      const validatedData = updateTradingPlanStatusSchema.parse(body);

      // Check if trading plan exists
      const existingTradingPlan = await postgresDb
        .select({ id: trading_plans.id })
        .from(trading_plans)
        .where(eq(trading_plans.id, id))
        .limit(1);

      if (existingTradingPlan.length === 0) {
        return c.json(
          {
            message: "Trading plan not found",
            error: `Trading plan with ID ${id} does not exist`,
          },
          404
        );
      }

      // Update status
      const [updatedTradingPlan] = await postgresDb
        .update(trading_plans)
        .set({
          is_active: validatedData.is_active,
        })
        .where(eq(trading_plans.id, id))
        .returning();

      return c.json({
        message: "Trading plan status updated successfully",
        data: updatedTradingPlan,
      });
    } catch (error: any) {
      console.error("Error updating trading plan status:", error);

      if (error.name === "ZodError") {
        return c.json(
          {
            message: "Validation error",
            error: error.errors,
          },
          400
        );
      }

      return c.json(
        {
          message: "Failed to update trading plan status",
          error: error.message,
        },
        500
      );
    }
  },

  // Update trading plan visibility
  updateTradingPlanVisibility: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid trading plan ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      const body = await c.req.json();
      const validatedData = updateTradingPlanVisibilitySchema.parse(body);

      // Check if trading plan exists
      const existingTradingPlan = await postgresDb
        .select({ id: trading_plans.id })
        .from(trading_plans)
        .where(eq(trading_plans.id, id))
        .limit(1);

      if (existingTradingPlan.length === 0) {
        return c.json(
          {
            message: "Trading plan not found",
            error: `Trading plan with ID ${id} does not exist`,
          },
          404
        );
      }

      // Update visibility
      const [updatedTradingPlan] = await postgresDb
        .update(trading_plans)
        .set({
          visibility: validatedData.visibility,
        })
        .where(eq(trading_plans.id, id))
        .returning();

      return c.json({
        message: "Trading plan visibility updated successfully",
        data: updatedTradingPlan,
      });
    } catch (error: any) {
      console.error("Error updating trading plan visibility:", error);

      if (error.name === "ZodError") {
        return c.json(
          {
            message: "Validation error",
            error: error.errors,
          },
          400
        );
      }

      return c.json(
        {
          message: "Failed to update trading plan visibility",
          error: error.message,
        },
        500
      );
    }
  },

  // Update trading plan metrics
  updateTradingPlanMetrics: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid trading plan ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      const body = await c.req.json();
      const validatedData = updateTradingPlanMetricsSchema.parse(body);

      // Check if trading plan exists
      const existingTradingPlan = await postgresDb
        .select({ id: trading_plans.id })
        .from(trading_plans)
        .where(eq(trading_plans.id, id))
        .limit(1);

      if (existingTradingPlan.length === 0) {
        return c.json(
          {
            message: "Trading plan not found",
            error: `Trading plan with ID ${id} does not exist`,
          },
          404
        );
      }

      // Update metrics
      const [updatedTradingPlan] = await postgresDb
        .update(trading_plans)
        .set({
          pnl_30d: validatedData.pnl_30d,
          max_dd: validatedData.max_dd,
          sharpe: validatedData.sharpe,
        })
        .where(eq(trading_plans.id, id))
        .returning();

      return c.json({
        message: "Trading plan metrics updated successfully",
        data: updatedTradingPlan,
      });
    } catch (error: any) {
      console.error("Error updating trading plan metrics:", error);

      if (error.name === "ZodError") {
        return c.json(
          {
            message: "Validation error",
            error: error.errors,
          },
          400
        );
      }

      return c.json(
        {
          message: "Failed to update trading plan metrics",
          error: error.message,
        },
        500
      );
    }
  },

  // Update trading plan followers
  updateTradingPlanFollowers: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid trading plan ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      const body = await c.req.json();
      const validatedData = updateTradingPlanFollowersSchema.parse(body);

      // Check if trading plan exists
      const existingTradingPlan = await postgresDb
        .select({ id: trading_plans.id })
        .from(trading_plans)
        .where(eq(trading_plans.id, id))
        .limit(1);

      if (existingTradingPlan.length === 0) {
        return c.json(
          {
            message: "Trading plan not found",
            error: `Trading plan with ID ${id} does not exist`,
          },
          404
        );
      }

      // Update followers
      const [updatedTradingPlan] = await postgresDb
        .update(trading_plans)
        .set({
          total_followers: validatedData.total_followers,
        })
        .where(eq(trading_plans.id, id))
        .returning();

      return c.json({
        message: "Trading plan followers updated successfully",
        data: updatedTradingPlan,
      });
    } catch (error: any) {
      console.error("Error updating trading plan followers:", error);

      if (error.name === "ZodError") {
        return c.json(
          {
            message: "Validation error",
            error: error.errors,
          },
          400
        );
      }

      return c.json(
        {
          message: "Failed to update trading plan followers",
          error: error.message,
        },
        500
      );
    }
  },

  // Batch create trading plans
  batchCreateTradingPlans: async function (c: Context) {
    try {
      const body = await c.req.json();
      const validatedData = batchTradingPlanSchema.parse(body);

      if (validatedData.trading_plans.length === 0) {
        return c.json(
          {
            message: "No trading plans provided",
            error: "At least one trading plan must be provided for batch creation",
          },
          400
        );
      }

      // Check all owner users exist
      const ownerUserIds = [...new Set(validatedData.trading_plans.map((tp: any) => tp.owner_user_id))];
      const existingUsers = await postgresDb
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, ownerUserIds as number[]));

      const existingUserIds = new Set(existingUsers.map(u => u.id));
      const missingUserIds = (ownerUserIds as number[]).filter(id => !existingUserIds.has(id));

      if (missingUserIds.length > 0) {
        return c.json(
          {
            message: "Users not found",
            error: `Users with IDs ${missingUserIds.join(", ")} do not exist`,
          },
          404
        );
      }

      // Insert all trading plans
      const createdTradingPlans = await postgresDb
        .insert(trading_plans)
        .values(validatedData.trading_plans)
        .returning();

      return c.json(
        {
          message: "Trading plans created successfully",
          data: createdTradingPlans,
          count: createdTradingPlans.length,
        },
        201
      );
    } catch (error: any) {
      console.error("Error batch creating trading plans:", error);

      if (error.name === "ZodError") {
        return c.json(
          {
            message: "Validation error",
            error: error.errors,
          },
          400
        );
      }

      return c.json(
        {
          message: "Failed to batch create trading plans",
          error: error.message,
        },
        500
      );
    }
  },

  // Get trading plan statistics
  getTradingPlanStats: async function (c: Context) {
    try {
      const ownerUserId = c.req.query("owner_user_id");
      const visibility = c.req.query("visibility");
      const isActive = c.req.query("is_active");

      // Build conditions
      const conditions = [];
      if (ownerUserId) conditions.push(eq(trading_plans.owner_user_id, parseInt(ownerUserId)));
      if (visibility) conditions.push(eq(trading_plans.visibility, visibility));
      if (isActive) conditions.push(eq(trading_plans.is_active, isActive === "true"));

      // Get total count
      const totalResult = await postgresDb
        .select({ count: sql<number>`count(*)` })
        .from(trading_plans)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      // Get count by visibility
      const visibilityResult = await postgresDb
        .select({
          visibility: trading_plans.visibility,
          count: sql<number>`count(*)`,
        })
        .from(trading_plans)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .groupBy(trading_plans.visibility);

      // Get count by status
      const statusResult = await postgresDb
        .select({
          is_active: trading_plans.is_active,
          count: sql<number>`count(*)`,
        })
        .from(trading_plans)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .groupBy(trading_plans.is_active);

      // Get average metrics
      const metricsResult = await postgresDb
        .select({
          avg_pnl_30d: sql<number>`avg(pnl_30d::numeric)`,
          avg_max_dd: sql<number>`avg(max_dd::numeric)`,
          avg_sharpe: sql<number>`avg(sharpe::numeric)`,
          avg_followers: sql<number>`avg(total_followers)`,
        })
        .from(trading_plans)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      // Get top trading plans by followers
      const topByFollowersResult = await postgresDb
        .select({
          id: trading_plans.id,
          name: trading_plans.name,
          owner_user_id: trading_plans.owner_user_id,
          total_followers: trading_plans.total_followers,
          pnl_30d: trading_plans.pnl_30d,
          sharpe: trading_plans.sharpe,
        })
        .from(trading_plans)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(trading_plans.total_followers))
        .limit(10);

      const stats = {
        total: totalResult[0]?.count || 0,
        by_visibility: Object.fromEntries(
          visibilityResult.map(row => [row.visibility, row.count])
        ),
        by_status: Object.fromEntries(
          statusResult.map(row => [row.is_active ? "active" : "inactive", row.count])
        ),
        average_metrics: {
          pnl_30d: metricsResult[0]?.avg_pnl_30d || "0",
          max_dd: metricsResult[0]?.avg_max_dd || "0",
          sharpe: metricsResult[0]?.avg_sharpe || "0",
          followers: metricsResult[0]?.avg_followers || 0,
        },
        top_by_followers: topByFollowersResult,
      };

      return c.json({
        message: "Trading plan statistics retrieved successfully",
        data: stats,
      });
    } catch (error: any) {
      console.error("Error getting trading plan statistics:", error);
      return c.json(
        {
          message: "Failed to retrieve trading plan statistics",
          error: error.message,
        },
        500
      );
    }
  },

  // ========== TRADING PLAN PAIRS CRUD ==========

  // Create a new trading plan pair
  createTradingPlanPair: async function (c: Context) {
    try {
      const body = await c.req.json();
      const validatedData = createTradingPlanPairSchema.parse(body);

      // Check if trading plan exists
      const tradingPlanExists = await postgresDb
        .select({ id: trading_plans.id })
        .from(trading_plans)
        .where(eq(trading_plans.id, validatedData.trading_plan_id))
        .limit(1);

      if (tradingPlanExists.length === 0) {
        return c.json(
          {
            message: "Trading plan not found",
            error: `Trading plan with ID ${validatedData.trading_plan_id} does not exist`,
          },
          404
        );
      }

      // Check for duplicate symbol within the same trading plan
      const existingPair = await postgresDb
        .select({ id: trading_plan_pairs.id })
        .from(trading_plan_pairs)
        .where(
          and(
            eq(trading_plan_pairs.trading_plan_id, validatedData.trading_plan_id),
            eq(trading_plan_pairs.symbol, validatedData.symbol)
          )
        )
        .limit(1);

      if (existingPair.length > 0) {
        return c.json(
          {
            message: "Trading plan pair already exists",
            error: `A pair with symbol ${validatedData.symbol} already exists for this trading plan`,
          },
          409
        );
      }

      // Create the trading plan pair
      const [newPair] = await postgresDb
        .insert(trading_plan_pairs)
        .values(validatedData)
        .returning();

      return c.json(
        {
          message: "Trading plan pair created successfully",
          data: newPair,
        },
        201
      );
    } catch (error: any) {
      console.error("Error creating trading plan pair:", error);

      if (error.name === "ZodError") {
        return c.json(
          {
            message: "Validation error",
            error: error.errors,
          },
          400
        );
      }

      return c.json(
        {
          message: "Failed to create trading plan pair",
          error: error.message,
        },
        500
      );
    }
  },

  // Get trading plan pair by ID
  getTradingPlanPairById: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid trading plan pair ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      const pair = await postgresDb
        .select()
        .from(trading_plan_pairs)
        .where(eq(trading_plan_pairs.id, id))
        .limit(1);

      if (pair.length === 0) {
        return c.json(
          {
            message: "Trading plan pair not found",
            error: `Trading plan pair with ID ${id} does not exist`,
          },
          404
        );
      }

      return c.json({
        message: "Trading plan pair retrieved successfully",
        data: pair[0],
      });
    } catch (error: any) {
      console.error("Error getting trading plan pair:", error);
      return c.json(
        {
          message: "Failed to retrieve trading plan pair",
          error: error.message,
        },
        500
      );
    }
  },

  // Query trading plan pairs with filters
  queryTradingPlanPairs: async function (c: Context) {
    try {
      const queryParams = c.req.query();
      const validatedQuery = queryTradingPlanPairSchema.parse({
        ...queryParams,
        id: queryParams.id ? parseInt(queryParams.id) : undefined,
        trading_plan_id: queryParams.trading_plan_id ? parseInt(queryParams.trading_plan_id) : undefined,
        limit: queryParams.limit ? parseInt(queryParams.limit) : undefined,
        offset: queryParams.offset ? parseInt(queryParams.offset) : undefined,
      });

      // Build where conditions
      const conditions = [];

      if (validatedQuery.id) conditions.push(eq(trading_plan_pairs.id, validatedQuery.id));
      if (validatedQuery.trading_plan_id) conditions.push(eq(trading_plan_pairs.trading_plan_id, validatedQuery.trading_plan_id));
      if (validatedQuery.base_asset) conditions.push(sql`${trading_plan_pairs.base_asset} ILIKE ${`%${validatedQuery.base_asset}%`}`);
      if (validatedQuery.quote_asset) conditions.push(sql`${trading_plan_pairs.quote_asset} ILIKE ${`%${validatedQuery.quote_asset}%`}`);
      if (validatedQuery.symbol) conditions.push(sql`${trading_plan_pairs.symbol} ILIKE ${`%${validatedQuery.symbol}%`}`);

      // Build order by
      const orderBy = validatedQuery.sort_order === "desc"
        ? desc(trading_plan_pairs[validatedQuery.sort_by as keyof typeof trading_plan_pairs.$inferSelect])
        : asc(trading_plan_pairs[validatedQuery.sort_by as keyof typeof trading_plan_pairs.$inferSelect]);

      // Execute query
      const results = await postgresDb
        .select()
        .from(trading_plan_pairs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(orderBy)
        .limit(validatedQuery.limit)
        .offset(validatedQuery.offset);

      // Get total count for pagination
      const totalResult = await postgresDb
        .select({ count: sql<number>`count(*)` })
        .from(trading_plan_pairs)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      const total = totalResult[0]?.count || 0;

      return c.json({
        message: "Trading plan pairs retrieved successfully",
        data: results,
        pagination: {
          total,
          limit: validatedQuery.limit,
          offset: validatedQuery.offset,
          has_more: validatedQuery.offset + validatedQuery.limit < total,
        },
      });
    } catch (error: any) {
      console.error("Error querying trading plan pairs:", error);

      if (error.name === "ZodError") {
        return c.json(
          {
            message: "Validation error",
            error: error.errors,
          },
          400
        );
      }

      return c.json(
        {
          message: "Failed to query trading plan pairs",
          error: error.message,
        },
        500
      );
    }
  },

  // Update trading plan pair by ID
  updateTradingPlanPair: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid trading plan pair ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      const body = await c.req.json();
      const validatedData = updateTradingPlanPairSchema.parse(body);

      // Check if trading plan pair exists
      const existingPair = await postgresDb
        .select({ id: trading_plan_pairs.id })
        .from(trading_plan_pairs)
        .where(eq(trading_plan_pairs.id, id))
        .limit(1);

      if (existingPair.length === 0) {
        return c.json(
          {
            message: "Trading plan pair not found",
            error: `Trading plan pair with ID ${id} does not exist`,
          },
          404
        );
      }

      // Validate trading plan if provided
      if (validatedData.trading_plan_id !== undefined) {
        const tradingPlanExists = await postgresDb
          .select({ id: trading_plans.id })
          .from(trading_plans)
          .where(eq(trading_plans.id, validatedData.trading_plan_id))
          .limit(1);

        if (tradingPlanExists.length === 0) {
          return c.json(
            {
              message: "Trading plan not found",
              error: `Trading plan with ID ${validatedData.trading_plan_id} does not exist`,
            },
            404
          );
        }
      }

      // Check for duplicate symbol if symbol or trading_plan_id is being updated
      if (validatedData.symbol !== undefined || validatedData.trading_plan_id !== undefined) {
        const currentPair = await postgresDb
          .select()
          .from(trading_plan_pairs)
          .where(eq(trading_plan_pairs.id, id))
          .limit(1);

        const tradingPlanId = validatedData.trading_plan_id ?? currentPair[0].trading_plan_id;
        const symbol = validatedData.symbol ?? currentPair[0].symbol;

        const duplicateCheck = await postgresDb
          .select({ id: trading_plan_pairs.id })
          .from(trading_plan_pairs)
          .where(
            and(
              eq(trading_plan_pairs.trading_plan_id, tradingPlanId),
              eq(trading_plan_pairs.symbol, symbol),
              sql`${trading_plan_pairs.id} != ${id}`
            )
          )
          .limit(1);

        if (duplicateCheck.length > 0) {
          return c.json(
            {
              message: "Duplicate trading plan pair",
              error: `A pair with symbol ${symbol} already exists for this trading plan`,
            },
            409
          );
        }
      }

      // Update the trading plan pair
      const [updatedPair] = await postgresDb
        .update(trading_plan_pairs)
        .set(validatedData)
        .where(eq(trading_plan_pairs.id, id))
        .returning();

      return c.json({
        message: "Trading plan pair updated successfully",
        data: updatedPair,
      });
    } catch (error: any) {
      console.error("Error updating trading plan pair:", error);

      if (error.name === "ZodError") {
        return c.json(
          {
            message: "Validation error",
            error: error.errors,
          },
          400
        );
      }

      return c.json(
        {
          message: "Failed to update trading plan pair",
          error: error.message,
        },
        500
      );
    }
  },

  // Delete trading plan pair by ID
  deleteTradingPlanPair: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid trading plan pair ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      // Check if trading plan pair exists
      const existingPair = await postgresDb
        .select({ id: trading_plan_pairs.id })
        .from(trading_plan_pairs)
        .where(eq(trading_plan_pairs.id, id))
        .limit(1);

      if (existingPair.length === 0) {
        return c.json(
          {
            message: "Trading plan pair not found",
            error: `Trading plan pair with ID ${id} does not exist`,
          },
          404
        );
      }

      // Delete the trading plan pair
      await postgresDb
        .delete(trading_plan_pairs)
        .where(eq(trading_plan_pairs.id, id));

      return c.json({
        message: "Trading plan pair deleted successfully",
        data: { id },
      });
    } catch (error: any) {
      console.error("Error deleting trading plan pair:", error);
      return c.json(
        {
          message: "Failed to delete trading plan pair",
          error: error.message,
        },
        500
      );
    }
  },

  // Batch create trading plan pairs
  batchCreateTradingPlanPairs: async function (c: Context) {
    try {
      const body = await c.req.json();
      const validatedData = batchTradingPlanPairSchema.parse(body);

      if (validatedData.trading_plan_pairs.length === 0) {
        return c.json(
          {
            message: "No trading plan pairs provided",
            error: "At least one trading plan pair must be provided for batch creation",
          },
          400
        );
      }

      // Check all trading plans exist
      const tradingPlanIds = [...new Set(validatedData.trading_plan_pairs.map((pair: any) => pair.trading_plan_id))];
      const existingTradingPlans = await postgresDb
        .select({ id: trading_plans.id })
        .from(trading_plans)
        .where(inArray(trading_plans.id, tradingPlanIds as number[]));

      const existingTradingPlanIds = new Set(existingTradingPlans.map(tp => tp.id));
      const missingTradingPlanIds = (tradingPlanIds as number[]).filter(id => !existingTradingPlanIds.has(id));

      if (missingTradingPlanIds.length > 0) {
        return c.json(
          {
            message: "Trading plans not found",
            error: `Trading plans with IDs ${missingTradingPlanIds.join(", ")} do not exist`,
          },
          404
        );
      }

      // Check for duplicates within the batch
      const batchSymbolsByPlan = new Map<number, Set<string>>();
      for (const pair of validatedData.trading_plan_pairs as any[]) {
        if (!batchSymbolsByPlan.has(pair.trading_plan_id)) {
          batchSymbolsByPlan.set(pair.trading_plan_id, new Set());
        }
        const symbols = batchSymbolsByPlan.get(pair.trading_plan_id)!;
        if (symbols.has(pair.symbol)) {
          return c.json(
            {
              message: "Duplicate symbol in batch",
              error: `Symbol ${pair.symbol} appears multiple times for trading plan ${pair.trading_plan_id}`,
            },
            400
          );
        }
        symbols.add(pair.symbol);
      }

      // Check for existing duplicates in database
      const existingPairs = await postgresDb
        .select({
          trading_plan_id: trading_plan_pairs.trading_plan_id,
          symbol: trading_plan_pairs.symbol,
        })
        .from(trading_plan_pairs)
        .where(
          inArray(
            trading_plan_pairs.trading_plan_id,
            Array.from(batchSymbolsByPlan.keys())
          )
        );

      const existingPairsSet = new Set(
        existingPairs.map(p => `${p.trading_plan_id}:${p.symbol}`)
      );

      const duplicatePairs = validatedData.trading_plan_pairs.filter((pair: any) =>
        existingPairsSet.has(`${pair.trading_plan_id}:${pair.symbol}`)
      );

      if (duplicatePairs.length > 0) {
        const duplicateInfo = duplicatePairs.map((p: any) =>
          `symbol ${p.symbol} for trading plan ${p.trading_plan_id}`
        );
        return c.json(
          {
            message: "Trading plan pairs already exist",
            error: `The following pairs already exist: ${duplicateInfo.join(", ")}`,
          },
          409
        );
      }

      // Insert all trading plan pairs
      const createdPairs = await postgresDb
        .insert(trading_plan_pairs)
        .values(validatedData.trading_plan_pairs)
        .returning();

      return c.json(
        {
          message: "Trading plan pairs created successfully",
          data: createdPairs,
          count: createdPairs.length,
        },
        201
      );
    } catch (error: any) {
      console.error("Error batch creating trading plan pairs:", error);

      if (error.name === "ZodError") {
        return c.json(
          {
            message: "Validation error",
            error: error.errors,
          },
          400
        );
      }

      return c.json(
        {
          message: "Failed to batch create trading plan pairs",
          error: error.message,
        },
        500
      );
    }
  },

  // Get trading plan pairs by trading plan ID
  getPairsByTradingPlanId: async function (c: Context) {
    try {
      const tradingPlanId = parseInt(c.req.param("trading_plan_id"));

      if (isNaN(tradingPlanId) || tradingPlanId <= 0) {
        return c.json(
          {
            message: "Invalid trading plan ID",
            error: "Trading plan ID must be a positive integer",
          },
          400
        );
      }

      // Check if trading plan exists
      const tradingPlanExists = await postgresDb
        .select({ id: trading_plans.id })
        .from(trading_plans)
        .where(eq(trading_plans.id, tradingPlanId))
        .limit(1);

      if (tradingPlanExists.length === 0) {
        return c.json(
          {
            message: "Trading plan not found",
            error: `Trading plan with ID ${tradingPlanId} does not exist`,
          },
          404
        );
      }

      // Get query parameters
      const queryParams = c.req.query();
      const limit = queryParams.limit ? parseInt(queryParams.limit) : 100;
      const offset = queryParams.offset ? parseInt(queryParams.offset) : 0;
      const sortBy = queryParams.sort_by || "symbol";
      const sortOrder = queryParams.sort_order || "asc";

      // Validate limit
      if (limit < 1 || limit > 100) {
        return c.json(
          {
            message: "Invalid limit",
            error: "Limit must be between 1 and 100",
          },
          400
        );
      }

      // Validate offset
      if (offset < 0) {
        return c.json(
          {
            message: "Invalid offset",
            error: "Offset must be non-negative",
          },
          400
        );
      }

      // Build order by
      const orderBy = sortOrder === "desc"
        ? desc(trading_plan_pairs[sortBy as keyof typeof trading_plan_pairs.$inferSelect])
        : asc(trading_plan_pairs[sortBy as keyof typeof trading_plan_pairs.$inferSelect]);

      // Get pairs for the trading plan
      const pairs = await postgresDb
        .select()
        .from(trading_plan_pairs)
        .where(eq(trading_plan_pairs.trading_plan_id, tradingPlanId))
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset);

      // Get total count for pagination
      const totalResult = await postgresDb
        .select({ count: sql<number>`count(*)` })
        .from(trading_plan_pairs)
        .where(eq(trading_plan_pairs.trading_plan_id, tradingPlanId));

      const total = totalResult[0]?.count || 0;

      return c.json({
        message: "Trading plan pairs retrieved successfully",
        data: pairs,
        trading_plan_id: tradingPlanId,
        pagination: {
          total,
          limit,
          offset,
          has_more: offset + limit < total,
        },
      });
    } catch (error: any) {
      console.error("Error getting trading plan pairs:", error);
      return c.json(
        {
          message: "Failed to retrieve trading plan pairs",
          error: error.message,
        },
        500
      );
    }
  },

  // Get trading plan with its pairs
  getTradingPlanWithPairs: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid trading plan ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      // Get trading plan
      const tradingPlan = await postgresDb
        .select()
        .from(trading_plans)
        .where(eq(trading_plans.id, id))
        .limit(1);

      if (tradingPlan.length === 0) {
        return c.json(
          {
            message: "Trading plan not found",
            error: `Trading plan with ID ${id} does not exist`,
          },
          404
        );
      }

      // Get associated pairs
      const pairs = await postgresDb
        .select()
        .from(trading_plan_pairs)
        .where(eq(trading_plan_pairs.trading_plan_id, id))
        .orderBy(asc(trading_plan_pairs.symbol));

      return c.json({
        message: "Trading plan with pairs retrieved successfully",
        data: {
          ...tradingPlan[0],
          pairs,
          pair_count: pairs.length,
        },
      });
    } catch (error: any) {
      console.error("Error getting trading plan with pairs:", error);
      return c.json(
        {
          message: "Failed to retrieve trading plan with pairs",
          error: error.message,
        },
        500
      );
    }
  },
}
