import { Hono } from 'hono';
import Redis from 'ioredis';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { firebaseAuth } from '../utils/firebaseAdmin';
import { postgresDb } from '../db/client';
import { users, trades, exchanges, autotraders, user_balances_snapshots, trading_plans, trading_plan_pairs } from '../db/schema';
import { and, eq, gte, lte, desc, sql, gt, isNotNull, inArray } from 'drizzle-orm';
import { validationErrorHandler } from '../middleware/validationErrorHandler';
import { signToken } from '../utils/jwt';
import { setCookie } from 'hono/cookie';
import { accountsQuerySchema, dashboardQuerySchema, loginSchema, tradesQuerySchema } from '../schemas/userSchemas';
import { jwt } from 'hono/jwt'

const userRouter = new Hono();

userRouter.get('/sse/orders/:userId', async (c) => {
  const userId = c.req.param('userId');
  const res = c.body(new ReadableStream({
    async start(controller) {
      const sub = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
      await sub.subscribe(`user:${userId}:orders:chan`);
      sub.on('message', (_ch, message) => {
        controller.enqueue(`data: ${message}\n\n`);
      });

      c.req.raw.signal.addEventListener('abort', async () => {
        await sub.unsubscribe(`user:${userId}:orders:chan`);
        sub.disconnect();
        controller.close();
      }, { once: true });
    }
  }), 200, { 'Content-Type': 'text/event-stream' });

  return res;
});



userRouter.post(
  '/login',
  zValidator('json', loginSchema, validationErrorHandler),
  async (c) => {
    const { idToken } = c.req.valid('json');
    console.log('verifying idToken :::', idToken);
    // 1. Verify Firebase token
    let decodedToken;
    try {
      decodedToken = await firebaseAuth.verifyIdToken(idToken);
    } catch {
      return c.json({ success: false, error: 'Invalid or expired token' }, 401);
    }

    const firebase_uid = decodedToken.uid;

    // 2. Find user in DB by firebase_uid
    const [user] = await postgresDb
      .select()
      .from(users)
      .where(eq(users.firebase_uid, firebase_uid))
      .limit(1);

    if (!user) {
      const [newUser] = await postgresDb
        .insert(users)
        .values({
          name: decodedToken.name ?? null,
          email: decodedToken.email!,
          firebase_uid,
          last_login_at: new Date(),
        })
        .returning();
      const newUserToken = await signToken({ sub: String(newUser.id), email: newUser.email ?? '', firebase_uid: newUser.firebase_uid ?? '' });
      setCookie(c, 'token', newUserToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
      });
      return c.json({ success: true, token: newUserToken, user: { id: newUser.id, email: newUser.email, name: newUser.name, username: newUser.username, firebase_uid: newUser.firebase_uid } }, 201);
    }

    if (!user.is_active) {
      return c.json({ success: false, error: 'Account is inactive' }, 403);
    }

    await postgresDb
      .update(users)
      .set({ last_login_at: new Date() })
      .where(eq(users.id, user.id));

    const token = await signToken({ sub: String(user.id), email: user.email ?? '', firebase_uid: user.firebase_uid ?? '' });

    setCookie(c, 'token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });

    return c.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        firebase_uid: user.firebase_uid,
      },
    });
  }
);



userRouter.get(
  '/dashboard',
   jwt({ secret: process.env.JWT_SECRET! }),
  zValidator('query', dashboardQuerySchema, validationErrorHandler),
  async (c) => {
    const { period } = c.req.valid('query');
    const payload = c.get('jwtPayload');
    const user_id = payload.sub;

    const now = new Date();
    const periodStart = period === 'all' ? null : new Date(
      now.getTime() - ({ '7d': 7, '30d': 30, '90d': 90 }[period] * 24 * 60 * 60 * 1000)
    ).toISOString();

    const [
      accountsWithBalance,
      equityChart,
      tradeHistory,
      overviewStats,
      autotraderStats,
    ] = await Promise.all([

      // 1. Accounts summary — latest balance snapshot per exchange
      postgresDb.execute(sql`
        SELECT
          e.id          AS exchange_id,
          e.exchange_title,
          e.market_type,
          e.is_active,
          s.balance,
          s.currency,
          s.created_at  AS snapshot_at
        FROM ${exchanges} e
        LEFT JOIN LATERAL (
          SELECT balance, currency, created_at
          FROM ${user_balances_snapshots}
          WHERE exchange_id = e.id AND user_id = ${user_id}
          ORDER BY created_at DESC
          LIMIT 1
        ) s ON true
        WHERE e.user_id = ${user_id}
        ORDER BY s.balance DESC NULLS LAST
      `),

      // 2. Equity chart — aggregated daily balance totals within period
      postgresDb.execute(sql`
        SELECT
          date_trunc('day', created_at) AS day,
          SUM(balance)                  AS total_balance
        FROM ${user_balances_snapshots}
        WHERE user_id = ${user_id}
          ${periodStart ? sql`AND created_at >= ${periodStart}` : sql``}
        GROUP BY day
        ORDER BY day ASC
      `),

      // 3. Trade history — last 5 closed or failed trades with exchange name
      postgresDb
        .select({
          id: trades.id,
          contract: trades.contract,
          position_type: trades.position_type,
          market_type: trades.market_type,
          status: trades.status,
          pnl: trades.pnl,
          pnl_margin: trades.pnl_margin,
          price: trades.price,
          created_at: trades.created_at,
          exchange_title: exchanges.exchange_title,
        })
        .from(trades)
        .innerJoin(exchanges, eq(trades.exchange_id, exchanges.id))
        .where(
          and(
            eq(trades.user_id, user_id),
            eq(trades.is_tpsl, false),
          )
        )
        .orderBy(desc(trades.created_at))
        .limit(5),

      // 4. Overview stats — accounts, autotrader counts, trade stats, PnL, win rate
      postgresDb.execute(sql`
        WITH trade_stats AS (
          SELECT
            COUNT(*)                                          AS total_trades,
            SUM(CASE WHEN pnl IS NOT NULL THEN pnl::numeric ELSE 0 END) AS total_pnl,
            SUM(CASE WHEN pnl::numeric > 0 THEN 1 ELSE 0 END)           AS winning_trades,
            COUNT(CASE WHEN pnl IS NOT NULL THEN 1 END)                  AS closed_trades
          FROM ${trades}
          WHERE user_id = ${user_id} AND is_tpsl = false
        ),
        account_stats AS (
          SELECT
            COUNT(*)                                                     AS accounts_connected,
            SUM(CASE WHEN is_active THEN 1 ELSE 0 END)                  AS active_accounts
          FROM ${exchanges}
          WHERE user_id = ${user_id}
        ),
        autotrader_counts AS (
          SELECT
            COUNT(*)                                                     AS total_autotraders,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)         AS active_autotraders,
            SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END)        AS stopped_autotraders,
            SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END)         AS paused_autotraders
          FROM ${autotraders}
          WHERE user_id = ${user_id}
        ),
        initial_investment AS (
          SELECT COALESCE(SUM(initial_investment::numeric), 0) AS total_initial
          FROM ${autotraders}
          WHERE user_id = ${user_id}
        )
        SELECT
          a.accounts_connected,
          a.active_accounts,
          at.total_autotraders,
          at.active_autotraders,
          at.stopped_autotraders,
          at.paused_autotraders,
          t.total_trades,
          t.total_pnl,
          t.winning_trades,
          t.closed_trades,
          i.total_initial,
          CASE WHEN t.closed_trades > 0
            THEN ROUND((t.winning_trades::numeric / t.closed_trades) * 100, 2)
            ELSE 0
          END AS win_rate,
          CASE WHEN i.total_initial > 0
            THEN ROUND((t.total_pnl / i.total_initial) * 100, 2)
            ELSE 0
          END AS roi
        FROM account_stats a, autotrader_counts at, trade_stats t, initial_investment i
      `),

      // 5. Top 3 autotraders by win rate (min 1 closed trade)
      postgresDb.execute(sql`
        SELECT
          at.id,
          at.symbol,
          at.market,
          at.status,
          at.current_balance,
          at.initial_investment,
          e.exchange_title,
          COUNT(t.id)                                                    AS total_trades,
          SUM(CASE WHEN t.pnl::numeric > 0 THEN 1 ELSE 0 END)          AS winning_trades,
          CASE WHEN COUNT(t.id) > 0
            THEN ROUND((SUM(CASE WHEN t.pnl::numeric > 0 THEN 1 ELSE 0 END)::numeric / COUNT(t.id)) * 100, 2)
            ELSE 0
          END AS win_rate
        FROM ${autotraders} at
        INNER JOIN ${exchanges} e ON e.id = at.exchange_id
        LEFT JOIN ${trades} t ON t.autotrader_id = at.id
          AND t.is_tpsl = false
          AND t.pnl IS NOT NULL
        WHERE at.user_id = ${user_id}
        GROUP BY at.id, at.symbol, at.market, at.status, at.current_balance, at.initial_investment, e.exchange_title
        HAVING COUNT(t.id) > 0
        ORDER BY win_rate DESC
        LIMIT 3
      `),
    ]);

    const overview = (overviewStats as any[])[0] ?? {};
    const totalBalance = (accountsWithBalance as any[]).reduce(
      (sum, a) => sum + Number(a.balance ?? 0), 0
    );

    return c.json({
      equity_summary: {
        total_balance: totalBalance,
        chart: equityChart,
      },
      accounts_summary: accountsWithBalance,
      trade_history: tradeHistory,
      data_overview: {
        accounts_connected: Number(overview.accounts_connected ?? 0),
        active_accounts: Number(overview.active_accounts ?? 0),
        autotraders: {
          total: Number(overview.total_autotraders ?? 0),
          active: Number(overview.active_autotraders ?? 0),
          stopped: Number(overview.stopped_autotraders ?? 0),
          paused: Number(overview.paused_autotraders ?? 0),
        },
        trades: Number(overview.total_trades ?? 0),
        total_pnl: Number(overview.total_pnl ?? 0),
        win_rate: Number(overview.win_rate ?? 0),
        roi: Number(overview.roi ?? 0),
      },
      top_autotraders: autotraderStats,
    });
  }
);



userRouter.get('/accounts',
    jwt({ secret: process.env.JWT_SECRET! }),
  zValidator('query', accountsQuerySchema, validationErrorHandler),
   async (c) => {
    const payload = c.get('jwtPayload');
    const user_id = payload.sub;

  // 1. Find the literal last time a snapshot was recorded for this user
  const latestEntry = await postgresDb
    .select({ created_at: user_balances_snapshots.created_at })
    .from(user_balances_snapshots)
    .where(eq(user_balances_snapshots.user_id, user_id))
    .orderBy(desc(user_balances_snapshots.created_at))
    .limit(1);

  if (latestEntry.length === 0) {
    // If no snapshots exist, we should still return the exchanges 
    // but with 0 balances so the UI doesn't look broken.
    const userExchanges = await postgresDb
      .select()
      .from(exchanges)
      .where(eq(exchanges.user_id, user_id));
      
    return c.json({ data: userExchanges.map(ex => ({ ...ex, value: 0 })) });
  }

  const T0 = latestEntry[0].created_at;

  // 2. Modified helper: Use T0 (the actual last cron time) as the anchor
  const getSnapshotAt = (daysAgo: number, alias: string) => {
    return postgresDb
      .select({
        exchange_id: user_balances_snapshots.exchange_id,
        total: sql<number>`sum(${user_balances_snapshots.balance})`.mapWith(Number),
      })
      .from(user_balances_snapshots)
      .where(and(
        eq(user_balances_snapshots.user_id, user_id),
        // Look for the snapshot that happened exactly N days before the latest one
        // We use a 4-hour window to be safe if the cron took a while to run
        sql`${user_balances_snapshots.created_at} BETWEEN (${T0}::timestamp - interval '${daysAgo} days' - interval '2 hours') 
            AND (${T0}::timestamp - interval '${daysAgo} days' + interval '2 hours')`
      ))
      .groupBy(user_balances_snapshots.exchange_id)
      .as(alias);
  };

  const current = getSnapshotAt(0, 'curr');
  const d1 = getSnapshotAt(1, 'd1');
  const d7 = getSnapshotAt(7, 'd7');
  const d30 = getSnapshotAt(30, 'd30');

    const results = await postgresDb
      .select({
        exchange: exchanges,
        autotraderCount: sql<number>`(SELECT count(*) FROM ${autotraders} WHERE ${autotraders.exchange_id} = ${exchanges.id})`.mapWith(Number),
        valCurr: current.total,
        val1D: d1.total,
        val7D: d7.total,
        val30D: d30.total,
      })
      .from(exchanges)
      .leftJoin(current, eq(exchanges.id, current.exchange_id))
      .leftJoin(d1, eq(exchanges.id, d1.exchange_id))
      .leftJoin(d7, eq(exchanges.id, d7.exchange_id))
      .leftJoin(d30, eq(exchanges.id, d30.exchange_id))
      .where(eq(exchanges.user_id, user_id));

    // 3. Fetch Asset Distribution (per currency) for the "Assets" bar
    const assetsDistribution = await postgresDb
      .select({
        exchange_id: user_balances_snapshots.exchange_id,
        currency: user_balances_snapshots.currency,
        balance: user_balances_snapshots.balance,
      })
      .from(user_balances_snapshots)
      .where(and(
        eq(user_balances_snapshots.user_id, user_id),
        sql`${user_balances_snapshots.created_at} > now() - interval '2 hours'`
      ));

    // 4. Final Format to match AccountTableRow frontend interface
    const data = results.map((row) => {
      const curr = row.valCurr || 0;

      const calcChange = (prev: number | null) =>
        prev && prev > 0 ? parseFloat((((curr - prev) / prev) * 100).toFixed(2)) : 0;

      // Filter assets for this specific exchange and map colors
      const exchangeAssets = assetsDistribution
        .filter(a => a.exchange_id === row.exchange.id)
        .map(a => ({
          color: a.currency === 'USDT' ? '#4ade80' : a.currency === 'BTC' ? '#f59e0b' : '#60a5fa',
          pct: curr > 0 ? (Number(a.balance) / curr) * 100 : 0
        }));

      return {
        id: row.exchange.id.toString(),
        name: row.exchange.exchange_title.toUpperCase(),
        subName: row.exchange.exchange_user_id,
        value: curr,
        change1D: calcChange(row.val1D),
        change7D: calcChange(row.val7D),
        change30D: calcChange(row.val30D),
        autotraderCount: row.autotraderCount,
        market: row.exchange.market_type || 'spot',
        provider: row.exchange.exchange_title,
        autotrader: row.autotraderCount > 0 ? 'Active' : 'None',
        assets: exchangeAssets.length > 0 ? exchangeAssets : [{ color: '#333', pct: 100 }]
      };
    });

    return c.json({ data });
  });

// GET /autotraders — list all autotraders for the authenticated user
userRouter.get('/autotraders',
  jwt({ secret: process.env.JWT_SECRET! }),
  async (c) => {
    const payload = c.get('jwtPayload');
    const user_id = Number(payload.sub);

    const results = await postgresDb
      .select({
        id: autotraders.id,
        exchange_id: autotraders.exchange_id,
        trading_plan_id: autotraders.trading_plan_id,
        market: autotraders.market,
        pair: autotraders.pair,
        symbol: autotraders.symbol,
        status: autotraders.status,
        initial_investment: autotraders.initial_investment,
        current_balance: autotraders.current_balance,
        leverage: autotraders.leverage,
        leverage_type: autotraders.leverage_type,
        margin_mode: autotraders.margin_mode,
        position_mode: autotraders.position_mode,
        autocompound: autotraders.autocompound,
        created_at: autotraders.created_at,
        webhook_token: autotraders.webhook_token,
        exchange_title: exchanges.exchange_title,
        trading_plan_name: trading_plans.name,
      })
      .from(autotraders)
      .innerJoin(exchanges, eq(autotraders.exchange_id, exchanges.id))
      .leftJoin(trading_plans, eq(autotraders.trading_plan_id, trading_plans.id))
      .where(eq(autotraders.user_id, user_id))
      .orderBy(desc(autotraders.created_at));

    return c.json({ data: results });
  }
);

// GET /trading-plans — list all trading plans owned by the authenticated user
userRouter.get('/trading-plans',
  jwt({ secret: process.env.JWT_SECRET! }),
  async (c) => {
    const payload = c.get('jwtPayload');
    const user_id = Number(payload.sub);

    const plans = await postgresDb
      .select()
      .from(trading_plans)
      .where(eq(trading_plans.owner_user_id, user_id))
      .orderBy(desc(trading_plans.created_at));

    const planIds = plans.map((p) => p.id);

    let pairs: typeof trading_plan_pairs.$inferSelect[] = [];
    if (planIds.length > 0) {
      pairs = await postgresDb
        .select()
        .from(trading_plan_pairs)
        .where(inArray(trading_plan_pairs.trading_plan_id, planIds));
    }

    const data = plans.map((plan) => ({
      ...plan,
      pairs: pairs.filter((p) => p.trading_plan_id === plan.id),
    }));

    return c.json({ data });
  }
);

// POST /trading-plans — create a new trading plan with pairs
userRouter.post('/trading-plans',
  jwt({ secret: process.env.JWT_SECRET! }),
  async (c) => {
    const payload = c.get('jwtPayload');
    const user_id = Number(payload.sub);
    const body = await c.req.json();

    const { name, description, strategy, visibility, pairs } = body;

    const [plan] = await postgresDb
      .insert(trading_plans)
      .values({
        owner_user_id: user_id,
        name,
        description: description ?? null,
        strategy: strategy ?? null,
        visibility: visibility ?? 'PRIVATE',
      })
      .returning();

    if (pairs && pairs.length > 0) {
      await postgresDb.insert(trading_plan_pairs).values(
        pairs.map((p: { base_asset: string; quote_asset: string; symbol: string }) => ({
          trading_plan_id: plan.id,
          base_asset: p.base_asset,
          quote_asset: p.quote_asset,
          symbol: p.symbol,
        }))
      );
    }

    const insertedPairs = await postgresDb
      .select()
      .from(trading_plan_pairs)
      .where(eq(trading_plan_pairs.trading_plan_id, plan.id));

    return c.json({ data: { ...plan, pairs: insertedPairs } }, 201);
  }
);

// POST /autotraders — create one or more autotraders (one per pair)
userRouter.post('/autotraders',
  jwt({ secret: process.env.JWT_SECRET! }),
  async (c) => {
    const payload = c.get('jwtPayload');
    const user_id = Number(payload.sub);
    const body = await c.req.json();

    const { exchange_id, trading_plan_id, market, pairs } = body;

    const inserted = await postgresDb
      .insert(autotraders)
      .values(
        pairs.map((p: {
          symbol: string;
          pair: string;
          initial_investment: string;
          leverage: number;
          leverage_type: string;
          margin_mode: string;
          position_mode: string;
        }) => ({
          user_id,
          exchange_id,
          trading_plan_id,
          market,
          market_code: null,
          pair: p.pair,
          symbol: p.symbol,
          initial_investment: p.initial_investment,
          current_balance: p.initial_investment,
          leverage: p.leverage,
          leverage_type: p.leverage_type,
          margin_mode: p.margin_mode,
          position_mode: p.position_mode,
          status: 'stopped',
          webhook_token: crypto.randomUUID(),
        }))
      )
      .returning();

    return c.json({ data: inserted }, 201);
  }
);

// GET /autotraders/:id — get a single autotrader with trade stats
userRouter.get('/autotraders/:id',
  jwt({ secret: process.env.JWT_SECRET! }),
  async (c) => {
    const payload = c.get('jwtPayload');
    const user_id = Number(payload.sub);
    const autotrader_id = Number(c.req.param('id'));

    // Fetch autotrader with exchange info
    const [autotrader] = await postgresDb
      .select({
        id: autotraders.id,
        exchange_id: autotraders.exchange_id,
        trading_plan_id: autotraders.trading_plan_id,
        market: autotraders.market,
        pair: autotraders.pair,
        symbol: autotraders.symbol,
        status: autotraders.status,
        initial_investment: autotraders.initial_investment,
        current_balance: autotraders.current_balance,
        leverage: autotraders.leverage,
        leverage_type: autotraders.leverage_type,
        margin_mode: autotraders.margin_mode,
        position_mode: autotraders.position_mode,
        autocompound: autotraders.autocompound,
        created_at: autotraders.created_at,
        webhook_token: autotraders.webhook_token,
        exchange_title: exchanges.exchange_title,
        trading_plan_name: trading_plans.name,
      })
      .from(autotraders)
      .innerJoin(exchanges, eq(autotraders.exchange_id, exchanges.id))
      .leftJoin(trading_plans, eq(autotraders.trading_plan_id, trading_plans.id))
      .where(and(eq(autotraders.id, autotrader_id), eq(autotraders.user_id, user_id)))
      .limit(1);

    if (!autotrader) {
      return c.json({ error: 'Autotrader not found' }, 404);
    }

    // Trade stats for this autotrader
    const [stats] = await postgresDb.execute(sql`
      SELECT
        COUNT(*)::int                                                    AS total_trades,
        COALESCE(SUM(CASE WHEN pnl::numeric > 0 THEN pnl::numeric ELSE 0 END), 0) AS total_profit,
        COALESCE(SUM(CASE WHEN pnl::numeric < 0 THEN ABS(pnl::numeric) ELSE 0 END), 0) AS total_loss,
        COALESCE(SUM(pnl::numeric), 0)                                  AS total_pnl,
        SUM(CASE WHEN pnl::numeric > 0 THEN 1 ELSE 0 END)::int         AS winning_trades,
        COUNT(CASE WHEN status = 'open' THEN 1 END)::int                AS pending_orders,
        CASE WHEN COUNT(*) > 0
          THEN ROUND((SUM(CASE WHEN pnl::numeric > 0 THEN 1 ELSE 0 END)::numeric / COUNT(*)) * 100, 2)
          ELSE 0
        END                                                              AS win_rate,
        CASE WHEN SUM(CASE WHEN pnl::numeric < 0 THEN ABS(pnl::numeric) ELSE 0 END) > 0
          THEN ROUND(SUM(CASE WHEN pnl::numeric > 0 THEN pnl::numeric ELSE 0 END) / SUM(CASE WHEN pnl::numeric < 0 THEN ABS(pnl::numeric) ELSE 0 END), 2)
          ELSE 0
        END                                                              AS profit_factor
      FROM ${trades}
      WHERE autotrader_id = ${autotrader_id}
        AND user_id = ${user_id}
        AND is_tpsl = false
    `) as any;

    return c.json({
      data: {
        ...autotrader,
        total_trades: Number(stats?.total_trades ?? 0),
        total_profit: Number(stats?.total_profit ?? 0),
        total_loss: Number(stats?.total_loss ?? 0),
        total_pnl: Number(stats?.total_pnl ?? 0),
        winning_trades: Number(stats?.winning_trades ?? 0),
        pending_orders: Number(stats?.pending_orders ?? 0),
        win_rate: Number(stats?.win_rate ?? 0),
        profit_factor: Number(stats?.profit_factor ?? 0),
      },
    });
  }
);

// GET /autotraders/:id/trades — get recent trades for an autotrader
userRouter.get('/autotraders/:id/trades',
  jwt({ secret: process.env.JWT_SECRET! }),
  async (c) => {
    const payload = c.get('jwtPayload');
    const user_id = Number(payload.sub);
    const autotrader_id = Number(c.req.param('id'));

    const results = await postgresDb
      .select({
        id: trades.id,
        trade_id: trades.trade_id,
        contract: trades.contract,
        position_type: trades.position_type,
        market_type: trades.market_type,
        size: trades.size,
        price: trades.price,
        leverage: trades.leverage,
        leverage_type: trades.leverage_type,
        status: trades.status,
        position_status: trades.position_status,
        pnl: trades.pnl,
        pnl_margin: trades.pnl_margin,
        open_fill_price: trades.open_fill_price,
        close_fill_price: trades.close_fill_price,
        created_at: trades.created_at,
        updated_at: trades.updated_at,
      })
      .from(trades)
      .where(and(
        eq(trades.autotrader_id, autotrader_id),
        eq(trades.user_id, user_id),
        eq(trades.is_tpsl, false),
      ))
      .orderBy(desc(trades.created_at))
      .limit(10);

    return c.json({ data: results });
  }
);

// DELETE /autotraders/:id — delete an autotrader
userRouter.delete('/autotraders/:id',
  jwt({ secret: process.env.JWT_SECRET! }),
  async (c) => {
    const payload = c.get('jwtPayload');
    const user_id = Number(payload.sub);
    const autotrader_id = Number(c.req.param('id'));

    const [deleted] = await postgresDb
      .delete(autotraders)
      .where(and(eq(autotraders.id, autotrader_id), eq(autotraders.user_id, user_id)))
      .returning({ id: autotraders.id });

    if (!deleted) {
      return c.json({ error: 'Autotrader not found' }, 404);
    }

    return c.json({ success: true, id: deleted.id });
  }
);

// GET /trades — paginated trade history for the authenticated user
userRouter.get('/trades',
  jwt({ secret: process.env.JWT_SECRET! }),
  zValidator('query', tradesQuerySchema, validationErrorHandler),
  async (c) => {
    const payload = c.get('jwtPayload');
    const user_id = Number(payload.sub);
    const { exchange_id, market_type, contract, position_type, status, date_from, date_to, limit, offset } = c.req.valid('query');

    const conditions = [
      eq(trades.user_id, user_id),
      eq(trades.is_tpsl, false),
    ];

    if (exchange_id) conditions.push(eq(trades.exchange_id, exchange_id));
    if (market_type) conditions.push(eq(trades.market_type, market_type));
    if (contract) conditions.push(eq(trades.contract, contract));
    if (position_type) conditions.push(eq(trades.position_type, position_type));
    if (status) conditions.push(eq(trades.status, status));
    if (date_from) conditions.push(gte(trades.created_at, new Date(date_from)));
    if (date_to) conditions.push(lte(trades.created_at, new Date(date_to)));

    const [results, [countRow]] = await Promise.all([
      postgresDb
        .select({
          id: trades.id,
          contract: trades.contract,
          position_type: trades.position_type,
          market_type: trades.market_type,
          size: trades.size,
          price: trades.price,
          status: trades.status,
          pnl: trades.pnl,
          pnl_margin: trades.pnl_margin,
          open_filled_at: trades.open_filled_at,
          created_at: trades.created_at,
          exchange_title: exchanges.exchange_title,
          exchange_user_id: exchanges.exchange_user_id,
          autotrader_symbol: autotraders.symbol,
        })
        .from(trades)
        .innerJoin(exchanges, eq(trades.exchange_id, exchanges.id))
        .innerJoin(autotraders, eq(trades.autotrader_id, autotraders.id))
        .where(and(...conditions))
        .orderBy(desc(trades.created_at))
        .limit(limit)
        .offset(offset),

      postgresDb
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(trades)
        .innerJoin(exchanges, eq(trades.exchange_id, exchanges.id))
        .where(and(...conditions)),
    ]);

    return c.json({ data: results, total: countRow.count, limit, offset });
  }
);

// GET /sse/trades — streams trade updates for the authenticated user
userRouter.get('/sse/trades',
  jwt({ secret: process.env.JWT_SECRET! }),
  async (c) => {
    const payload = c.get('jwtPayload');
    const user_id = Number(payload.sub);

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (data: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

        // Send a heartbeat every 30s to keep the connection alive
        const heartbeat = setInterval(() => {
          try { controller.enqueue(enc.encode(': ping\n\n')); } catch { /* closed */ }
        }, 30_000);

        const sub = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
        await sub.subscribe(`user:${user_id}:orders:chan`);

        sub.on('message', async (_ch, _message) => {
          try {
            // Re-fetch the latest trades from DB so the client gets clean, formatted data
            const results = await postgresDb
              .select({
                id: trades.id,
                contract: trades.contract,
                position_type: trades.position_type,
                market_type: trades.market_type,
                size: trades.size,
                price: trades.price,
                status: trades.status,
                pnl: trades.pnl,
                pnl_margin: trades.pnl_margin,
                open_filled_at: trades.open_filled_at,
                created_at: trades.created_at,
                exchange_title: exchanges.exchange_title,
                exchange_user_id: exchanges.exchange_user_id,
                autotrader_symbol: autotraders.symbol,
              })
              .from(trades)
              .innerJoin(exchanges, eq(trades.exchange_id, exchanges.id))
              .innerJoin(autotraders, eq(trades.autotrader_id, autotraders.id))
              .where(and(eq(trades.user_id, user_id), eq(trades.is_tpsl, false)))
              .orderBy(desc(trades.created_at))
              .limit(50);
            send({ type: 'trades', data: results });
          } catch (err) {
            console.error('[SSE /sse/trades] DB fetch error:', err);
          }
        });

        c.req.raw.signal.addEventListener('abort', async () => {
          clearInterval(heartbeat);
          await sub.unsubscribe(`user:${user_id}:orders:chan`);
          sub.disconnect();
          controller.close();
        }, { once: true });
      },
    });

    return c.body(stream, 200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  }
);

// GET /sse/autotraders/:id/trades — streams trade updates for a specific autotrader
userRouter.get('/sse/autotraders/:id/trades',
  jwt({ secret: process.env.JWT_SECRET! }),
  async (c) => {
    const payload = c.get('jwtPayload');
    const user_id = Number(payload.sub);
    const autotrader_id = Number(c.req.param('id'));

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (data: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

        const heartbeat = setInterval(() => {
          try { controller.enqueue(enc.encode(': ping\n\n')); } catch { /* closed */ }
        }, 30_000);

        const sub = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
        await sub.subscribe(`user:${user_id}:orders:chan`);

        sub.on('message', async (_ch, _message) => {
          try {
            const results = await postgresDb
              .select({
                id: trades.id,
                trade_id: trades.trade_id,
                contract: trades.contract,
                position_type: trades.position_type,
                market_type: trades.market_type,
                size: trades.size,
                price: trades.price,
                leverage: trades.leverage,
                leverage_type: trades.leverage_type,
                status: trades.status,
                position_status: trades.position_status,
                pnl: trades.pnl,
                pnl_margin: trades.pnl_margin,
                open_fill_price: trades.open_fill_price,
                close_fill_price: trades.close_fill_price,
                created_at: trades.created_at,
                updated_at: trades.updated_at,
              })
              .from(trades)
              .where(and(
                eq(trades.autotrader_id, autotrader_id),
                eq(trades.user_id, user_id),
                eq(trades.is_tpsl, false),
              ))
              .orderBy(desc(trades.created_at))
              .limit(10);
            send({ type: 'trades', data: results });
          } catch (err) {
            console.error('[SSE /sse/autotraders/:id/trades] DB fetch error:', err);
          }
        });

        c.req.raw.signal.addEventListener('abort', async () => {
          clearInterval(heartbeat);
          await sub.unsubscribe(`user:${user_id}:orders:chan`);
          sub.disconnect();
          controller.close();
        }, { once: true });
      },
    });

    return c.body(stream, 200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  }
);

userRouter.patch('/autotraders/:id/status',
  jwt({ secret: process.env.JWT_SECRET! }),
  async (c) => {
    const payload = c.get('jwtPayload');
    const user_id = Number(payload.sub);
    const autotrader_id = Number(c.req.param('id'));
    const { status } = await c.req.json() as { status: 'active' | 'stopped' };

    if (!['active', 'stopped'].includes(status)) {
      return c.json({ error: 'status must be "active" or "stopped"' }, 400);
    }

    const [updated] = await postgresDb
      .update(autotraders)
      .set({ status, updated_at: sql`NOW()` })
      .where(and(eq(autotraders.id, autotrader_id), eq(autotraders.user_id, user_id)))
      .returning({ id: autotraders.id, status: autotraders.status });

    if (!updated) {
      return c.json({ error: 'Autotrader not found' }, 404);
    }

    return c.json({ success: true, id: updated.id, status: updated.status });
  }
);

export default userRouter;
