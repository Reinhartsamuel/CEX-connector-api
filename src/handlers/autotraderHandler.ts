import { Context } from "hono";
import { postgresDb } from "../db/client";
import { autotraders, exchanges, users, trading_plans } from "../db/schema";
import { and, eq, desc, asc, like, inArray, sql } from "drizzle-orm";
import {
  createAutotraderSchema,
  updateAutotraderSchema,
  queryAutotraderSchema,
  updateAutotraderStatusSchema,
  updateAutotraderBalanceSchema,
  batchAutotraderSchema,
  CreateAutotraderInput,
  UpdateAutotraderInput,
  QueryAutotraderInput,
  UpdateAutotraderStatusInput,
  UpdateAutotraderBalanceInput,
  BatchAutotraderInput,
} from "../schemas/autotraderSchemas";

export const AutotraderHandler = {
  // Create a new autotrader
  create: async function (c: Context) {
    try {
      const body = await c.req.json();
      const validatedData = createAutotraderSchema.parse(body);

      // Check if user exists
      const userExists = await postgresDb
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, validatedData.user_id))
        .limit(1);

      if (userExists.length === 0) {
        return c.json(
          {
            message: "User not found",
            error: `User with ID ${validatedData.user_id} does not exist`,
          },
          404
        );
      }

      // Check if exchange exists
      const exchangeExists = await postgresDb
        .select({ id: exchanges.id })
        .from(exchanges)
        .where(eq(exchanges.id, validatedData.exchange_id))
        .limit(1);

      if (exchangeExists.length === 0) {
        return c.json(
          {
            message: "Exchange not found",
            error: `Exchange with ID ${validatedData.exchange_id} does not exist`,
          },
          404
        );
      }

      // Check if trading plan exists (if provided)
      if (validatedData.trading_plan_id) {
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

      // Check for unique constraint (user_id, exchange_id, trading_plan_id, symbol)
      const existingAutotrader = await postgresDb
        .select({ id: autotraders.id })
        .from(autotraders)
        .where(
          and(
            eq(autotraders.user_id, validatedData.user_id),
            eq(autotraders.exchange_id, validatedData.exchange_id),
            validatedData.trading_plan_id
              ? eq(autotraders.trading_plan_id, validatedData.trading_plan_id)
              : sql`${autotraders.trading_plan_id} IS NULL`,
            eq(autotraders.symbol, validatedData.symbol)
          )
        )
        .limit(1);

      if (existingAutotrader.length > 0) {
        return c.json(
          {
            message: "Autotrader already exists",
            error:
              "An autotrader with the same user, exchange, trading plan, and symbol already exists",
          },
          409
        );
      }

      // Set default values
      const autotraderData = {
        ...validatedData,
        status: validatedData.status || "active",
        current_balance: validatedData.current_balance || validatedData.initial_investment,
      };

      // Create the autotrader
      const [newAutotrader] = await postgresDb
        .insert(autotraders)
        .values(autotraderData)
        .returning();

      return c.json(
        {
          message: "Autotrader created successfully",
          data: newAutotrader,
        },
        201
      );
    } catch (error: any) {
      console.error("Error creating autotrader:", error);

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
          message: "Failed to create autotrader",
          error: error.message,
        },
        500
      );
    }
  },

  // Get autotrader by ID
  getById: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid autotrader ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      const autotrader = await postgresDb
        .select()
        .from(autotraders)
        .where(eq(autotraders.id, id))
        .limit(1);

      if (autotrader.length === 0) {
        return c.json(
          {
            message: "Autotrader not found",
            error: `Autotrader with ID ${id} does not exist`,
          },
          404
        );
      }

      return c.json({
        message: "Autotrader retrieved successfully",
        data: autotrader[0],
      });
    } catch (error: any) {
      console.error("Error getting autotrader:", error);
      return c.json(
        {
          message: "Failed to retrieve autotrader",
          error: error.message,
        },
        500
      );
    }
  },

  // Query autotraders with filters
  query: async function (c: Context) {
    try {
      const queryParams = c.req.query();
      const validatedQuery = queryAutotraderSchema.parse({
        ...queryParams,
        id: queryParams.id ? parseInt(queryParams.id) : undefined,
        user_id: queryParams.user_id ? parseInt(queryParams.user_id) : undefined,
        exchange_id: queryParams.exchange_id ? parseInt(queryParams.exchange_id) : undefined,
        trading_plan_id: queryParams.trading_plan_id ? parseInt(queryParams.trading_plan_id) : undefined,
        leverage: queryParams.leverage ? parseInt(queryParams.leverage) : undefined,
        limit: queryParams.limit ? parseInt(queryParams.limit) : undefined,
        offset: queryParams.offset ? parseInt(queryParams.offset) : undefined,
        autocompound: queryParams.autocompound ? queryParams.autocompound === "true" : undefined,
      });

      // Build where conditions
      const conditions = [];

      if (validatedQuery.id) conditions.push(eq(autotraders.id, validatedQuery.id));
      if (validatedQuery.user_id) conditions.push(eq(autotraders.user_id, validatedQuery.user_id));
      if (validatedQuery.exchange_id) conditions.push(eq(autotraders.exchange_id, validatedQuery.exchange_id));
      if (validatedQuery.trading_plan_id) conditions.push(eq(autotraders.trading_plan_id, validatedQuery.trading_plan_id));
      if (validatedQuery.market) conditions.push(eq(autotraders.market, validatedQuery.market));
      if (validatedQuery.market_code) conditions.push(eq(autotraders.market_code, validatedQuery.market_code));
      if (validatedQuery.pair) conditions.push(eq(autotraders.pair, validatedQuery.pair));
      if (validatedQuery.status) conditions.push(eq(autotraders.status, validatedQuery.status));
      if (validatedQuery.symbol) conditions.push(eq(autotraders.symbol, validatedQuery.symbol));
      if (validatedQuery.position_mode) conditions.push(eq(autotraders.position_mode, validatedQuery.position_mode));
      if (validatedQuery.margin_mode) conditions.push(eq(autotraders.margin_mode, validatedQuery.margin_mode));
      if (validatedQuery.leverage) conditions.push(eq(autotraders.leverage, validatedQuery.leverage));
      if (validatedQuery.leverage_type) conditions.push(eq(autotraders.leverage_type, validatedQuery.leverage_type));
      if (validatedQuery.autocompound !== undefined) conditions.push(eq(autotraders.autocompound, validatedQuery.autocompound));

      // Build order by
      const orderBy = validatedQuery.sort_order === "desc"
        ? desc(autotraders[validatedQuery.sort_by as keyof typeof autotraders.$inferSelect])
        : asc(autotraders[validatedQuery.sort_by as keyof typeof autotraders.$inferSelect]);

      // Execute query
      const results = await postgresDb
        .select()
        .from(autotraders)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(orderBy)
        .limit(validatedQuery.limit)
        .offset(validatedQuery.offset);

      // Get total count for pagination
      const totalResult = await postgresDb
        .select({ count: sql<number>`count(*)` })
        .from(autotraders)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      const total = totalResult[0]?.count || 0;

      return c.json({
        message: "Autotraders retrieved successfully",
        data: results,
        pagination: {
          total,
          limit: validatedQuery.limit,
          offset: validatedQuery.offset,
          has_more: validatedQuery.offset + validatedQuery.limit < total,
        },
      });
    } catch (error: any) {
      console.error("Error querying autotraders:", error);

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
          message: "Failed to query autotraders",
          error: error.message,
        },
        500
      );
    }
  },

  // Update autotrader by ID
  update: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid autotrader ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      const body = await c.req.json();
      const validatedData = updateAutotraderSchema.parse(body);

      // Check if autotrader exists
      const existingAutotrader = await postgresDb
        .select({ id: autotraders.id })
        .from(autotraders)
        .where(eq(autotraders.id, id))
        .limit(1);

      if (existingAutotrader.length === 0) {
        return c.json(
          {
            message: "Autotrader not found",
            error: `Autotrader with ID ${id} does not exist`,
          },
          404
        );
      }

      // Validate referenced entities if provided
      if (validatedData.user_id !== undefined) {
        const userExists = await postgresDb
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, validatedData.user_id))
          .limit(1);

        if (userExists.length === 0) {
          return c.json(
            {
              message: "User not found",
              error: `User with ID ${validatedData.user_id} does not exist`,
            },
            404
          );
        }
      }

      if (validatedData.exchange_id !== undefined) {
        const exchangeExists = await postgresDb
          .select({ id: exchanges.id })
          .from(exchanges)
          .where(eq(exchanges.id, validatedData.exchange_id))
          .limit(1);

        if (exchangeExists.length === 0) {
          return c.json(
            {
              message: "Exchange not found",
              error: `Exchange with ID ${validatedData.exchange_id} does not exist`,
            },
            404
          );
        }
      }

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

      // Check unique constraint if relevant fields are being updated
      if (
        validatedData.user_id !== undefined ||
        validatedData.exchange_id !== undefined ||
        validatedData.trading_plan_id !== undefined ||
        validatedData.symbol !== undefined
      ) {
        // Get current autotrader to compare
        const currentAutotrader = await postgresDb
          .select()
          .from(autotraders)
          .where(eq(autotraders.id, id))
          .limit(1);

        const userId = validatedData.user_id ?? currentAutotrader[0].user_id;
        const exchangeId = validatedData.exchange_id ?? currentAutotrader[0].exchange_id;
        const tradingPlanId = validatedData.trading_plan_id ?? currentAutotrader[0].trading_plan_id;
        const symbol = validatedData.symbol ?? currentAutotrader[0].symbol;

        const duplicateCheck = await postgresDb
          .select({ id: autotraders.id })
          .from(autotraders)
          .where(
            and(
              eq(autotraders.user_id, userId),
              eq(autotraders.exchange_id, exchangeId),
              tradingPlanId
                ? eq(autotraders.trading_plan_id, tradingPlanId)
                : sql`${autotraders.trading_plan_id} IS NULL`,
              eq(autotraders.symbol, symbol),
              sql`${autotraders.id} != ${id}`
            )
          )
          .limit(1);

        if (duplicateCheck.length > 0) {
          return c.json(
            {
              message: "Unique constraint violation",
              error:
                "An autotrader with the same user, exchange, trading plan, and symbol already exists",
            },
            409
          );
        }
      }

      // Update the autotrader
      const [updatedAutotrader] = await postgresDb
        .update(autotraders)
        .set({
          ...validatedData,
          updated_at: sql`NOW()`,
        })
        .where(eq(autotraders.id, id))
        .returning();

      return c.json({
        message: "Autotrader updated successfully",
        data: updatedAutotrader,
      });
    } catch (error: any) {
      console.error("Error updating autotrader:", error);

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
          message: "Failed to update autotrader",
          error: error.message,
        },
        500
      );
    }
  },

  // Delete autotrader by ID
  delete: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid autotrader ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      // Check if autotrader exists
      const existingAutotrader = await postgresDb
        .select({ id: autotraders.id })
        .from(autotraders)
        .where(eq(autotraders.id, id))
        .limit(1);

      if (existingAutotrader.length === 0) {
        return c.json(
          {
            message: "Autotrader not found",
            error: `Autotrader with ID ${id} does not exist`,
          },
          404
        );
      }

      // Delete the autotrader
      await postgresDb
        .delete(autotraders)
        .where(eq(autotraders.id, id));

      return c.json({
        message: "Autotrader deleted successfully",
        data: { id },
      });
    } catch (error: any) {
      console.error("Error deleting autotrader:", error);
      return c.json(
        {
          message: "Failed to delete autotrader",
          error: error.message,
        },
        500
      );
    }
  },

  // Update autotrader status
  updateStatus: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid autotrader ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      const body = await c.req.json();
      const validatedData = updateAutotraderStatusSchema.parse(body);

      // Check if autotrader exists
      const existingAutotrader = await postgresDb
        .select({ id: autotraders.id })
        .from(autotraders)
        .where(eq(autotraders.id, id))
        .limit(1);

      if (existingAutotrader.length === 0) {
        return c.json(
          {
            message: "Autotrader not found",
            error: `Autotrader with ID ${id} does not exist`,
          },
          404
        );
      }

      // Update status
      const [updatedAutotrader] = await postgresDb
        .update(autotraders)
        .set({
          status: validatedData.status,
          updated_at: sql`NOW()`,
        })
        .where(eq(autotraders.id, id))
        .returning();

      return c.json({
        message: "Autotrader status updated successfully",
        data: updatedAutotrader,
      });
    } catch (error: any) {
      console.error("Error updating autotrader status:", error);

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
          message: "Failed to update autotrader status",
          error: error.message,
        },
        500
      );
    }
  },

  // Update autotrader balance
  updateBalance: async function (c: Context) {
    try {
      const id = parseInt(c.req.param("id"));

      if (isNaN(id) || id <= 0) {
        return c.json(
          {
            message: "Invalid autotrader ID",
            error: "ID must be a positive integer",
          },
          400
        );
      }

      const body = await c.req.json();
      const validatedData = updateAutotraderBalanceSchema.parse(body);

      // Check if autotrader exists
      const existingAutotrader = await postgresDb
        .select({ id: autotraders.id })
        .from(autotraders)
        .where(eq(autotraders.id, id))
        .limit(1);

      if (existingAutotrader.length === 0) {
        return c.json(
          {
            message: "Autotrader not found",
            error: `Autotrader with ID ${id} does not exist`,
          },
          404
        );
      }

      // Update balance
      const [updatedAutotrader] = await postgresDb
        .update(autotraders)
        .set({
          current_balance: validatedData.current_balance,
          updated_at: sql`NOW()`,
        })
        .where(eq(autotraders.id, id))
        .returning();

      return c.json({
        message: "Autotrader balance updated successfully",
        data: updatedAutotrader,
      });
    } catch (error: any) {
      console.error("Error updating autotrader balance:", error);

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
          message: "Failed to update autotrader balance",
          error: error.message,
        },
        500
      );
    }
  },

  // Batch create autotraders
  batchCreate: async function (c: Context) {
    try {
      const body = await c.req.json();
      const validatedData = batchAutotraderSchema.parse(body);

      if (validatedData.autotraders.length === 0) {
        return c.json(
          {
            message: "No autotraders provided",
            error: "At least one autotrader must be provided for batch creation",
          },
          400
        );
      }

      // Check all users exist
      const userIds = [...new Set(validatedData.autotraders.map(at => at.user_id))];
      const existingUsers = await postgresDb
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, userIds));

      const existingUserIds = new Set(existingUsers.map(u => u.id));
      const missingUserIds = userIds.filter(id => !existingUserIds.has(id));

      if (missingUserIds.length > 0) {
        return c.json(
          {
            message: "Users not found",
            error: `Users with IDs ${missingUserIds.join(", ")} do not exist`,
          },
          404
        );
      }

      // Check all exchanges exist
      const exchangeIds = [...new Set(validatedData.autotraders.map(at => at.exchange_id))];
      const existingExchanges = await postgresDb
        .select({ id: exchanges.id })
        .from(exchanges)
        .where(inArray(exchanges.id, exchangeIds));

      const existingExchangeIds = new Set(existingExchanges.map(e => e.id));
      const missingExchangeIds = exchangeIds.filter(id => !existingExchangeIds.has(id));

      if (missingExchangeIds.length > 0) {
        return c.json(
          {
            message: "Exchanges not found",
            error: `Exchanges with IDs ${missingExchangeIds.join(", ")} do not exist`,
          },
          404
        );
      }

      // Check all trading plans exist (if any provided)
      const tradingPlanIds = validatedData.autotraders
        .map(at => at.trading_plan_id)
        .filter((id): id is number => id !== undefined);

      if (tradingPlanIds.length > 0) {
        const uniqueTradingPlanIds = [...new Set(tradingPlanIds)];
        const existingTradingPlans = await postgresDb
          .select({ id: trading_plans.id })
          .from(trading_plans)
          .where(inArray(trading_plans.id, uniqueTradingPlanIds));

        const existingTradingPlanIds = new Set(existingTradingPlans.map(tp => tp.id));
        const missingTradingPlanIds = uniqueTradingPlanIds.filter(id => !existingTradingPlanIds.has(id));

        if (missingTradingPlanIds.length > 0) {
          return c.json(
            {
              message: "Trading plans not found",
              error: `Trading plans with IDs ${missingTradingPlanIds.join(", ")} do not exist`,
            },
            404
          );
        }
      }

      // Prepare autotraders data with defaults
      const autotradersData = validatedData.autotraders.map(autotrader => ({
        ...autotrader,
        status: autotrader.status || "active",
        current_balance: autotrader.current_balance || autotrader.initial_investment,
      }));

      // Insert all autotraders
      const createdAutotraders = await postgresDb
        .insert(autotraders)
        .values(autotradersData)
        .returning();

      return c.json(
        {
          message: "Autotraders created successfully",
          data: createdAutotraders,
          count: createdAutotraders.length,
        },
        201
      );
    } catch (error: any) {
      console.error("Error batch creating autotraders:", error);

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
          message: "Failed to batch create autotraders",
          error: error.message,
        },
        500
      );
    }
  },

  // Get autotrader statistics
  getStats: async function (c: Context) {
    try {
      const userId = c.req.query("user_id");
      const exchangeId = c.req.query("exchange_id");

      // Build conditions
      const conditions = [];
      if (userId) conditions.push(eq(autotraders.user_id, parseInt(userId)));
      if (exchangeId) conditions.push(eq(autotraders.exchange_id, parseInt(exchangeId)));

      // Get total count
      const totalResult = await postgresDb
        .select({ count: sql<number>`count(*)` })
        .from(autotraders)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      // Get count by status
      const statusResult = await postgresDb
        .select({
          status: autotraders.status,
          count: sql<number>`count(*)`,
        })
        .from(autotraders)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .groupBy(autotraders.status);

      // Get total investment
      const investmentResult = await postgresDb
        .select({
          total_initial_investment: sql<number>`sum(initial_investment::numeric)`,
          total_current_balance: sql<number>`sum(current_balance::numeric)`,
        })
        .from(autotraders)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      // Get top symbols
      const topSymbolsResult = await postgresDb
        .select({
          symbol: autotraders.symbol,
          count: sql<number>`count(*)`,
          total_investment: sql<number>`sum(initial_investment::numeric)`,
        })
        .from(autotraders)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .groupBy(autotraders.symbol)
        .orderBy(sql`count(*) DESC`)
        .limit(10);

      const stats = {
        total: totalResult[0]?.count || 0,
        by_status: Object.fromEntries(
          statusResult.map(row => [row.status || "unknown", row.count])
        ),
        total_initial_investment: investmentResult[0]?.total_initial_investment || "0",
        total_current_balance: investmentResult[0]?.total_current_balance || "0",
        top_symbols: topSymbolsResult,
      };

      return c.json({
        message: "Autotrader statistics retrieved successfully",
        data: stats,
      });
    } catch (error: any) {
      console.error("Error getting autotrader statistics:", error);
      return c.json(
        {
          message: "Failed to retrieve autotrader statistics",
          error: error.message,
        },
        500
      );
    }
  },
};
