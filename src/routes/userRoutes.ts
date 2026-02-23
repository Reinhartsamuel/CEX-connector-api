import { Hono } from 'hono';
import Redis from 'ioredis';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { firebaseAuth } from '../utils/firebaseAdmin';
import { postgresDb } from '../db/client';
import { users, trades, exchanges, autotraders, user_balances_snapshots } from '../db/schema';
import { and, eq, gte, lte, desc, sql, gt, isNotNull } from 'drizzle-orm';
import { validationErrorHandler } from '../middleware/validationErrorHandler';
import { signToken } from '../utils/jwt';
import { setCookie } from 'hono/cookie';
import { accountsQuerySchema, dashboardQuerySchema, loginSchema, tradesQuerySchema } from '../schemas/userSchemas';
import {jwt } from 'hono/jwt'

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
  zValidator('query', dashboardQuerySchema, validationErrorHandler),
  async (c) => {
    const { user_id, period } = c.req.valid('query');

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



userRouter.get(
  '/accounts',
  jwt({ secret: process.env.JWT_SECRET! }),
  zValidator('query', accountsQuerySchema, validationErrorHandler),
  async (c) => {
    const q = c.req.valid('query');
    const payload = c.get('jwtPayload');
    const userIdFromToken = payload.sub;

    const conditions = [eq(exchanges.user_id, userIdFromToken)];
    if (q.market_type) conditions.push(eq(exchanges.market_type, q.market_type));
    if (q.exchange_title) conditions.push(eq(exchanges.exchange_title, q.exchange_title));

    // Fetch exchanges with their related autotraders and latest balances
    const results = await postgresDb
      .select({
        exchange: exchanges,
        // Count active autotraders for this specific exchange
        autotraderCount: sql<number>`count(distinct ${autotraders.id})`,
        // Sum total balance for this exchange
        totalValue: sql<number>`coalesce(sum(${user_balances_snapshots.balance}), 0)`,
      })
      .from(exchanges)
      .leftJoin(autotraders, eq(autotraders.exchange_id, exchanges.id))
      .leftJoin(user_balances_snapshots, eq(user_balances_snapshots.exchange_id, exchanges.id))
      .where(and(...conditions))
      .groupBy(exchanges.id)
      .orderBy(desc(exchanges.created_at))
      .limit(q.limit)
      .offset(q.offset);

    // Map DB results to the Frontend "AccountTableRow" interface
    const formattedData = results.map((row) => {
      const { exchange, autotraderCount, totalValue } = row;

      return {
        id: exchange.id.toString(),
        name: exchange.exchange_title.toUpperCase(), // e.g., 'BINANCE'
        subName: exchange.exchange_user_id,          // e.g., User ID or Email
        value: Number(totalValue),
        
        // These snapshots would usually require a subquery comparing 
        // current user_pnl_snapshots vs 24h ago. 
        // Hardcoded as 0 or mock for now to match interface.
        change1D: 0.0, 
        change7D: 0.0,
        change30D: 0.0,
        
        autotraderCount: Number(autotraderCount),
        market: exchange.market_type || 'spot',
        provider: exchange.exchange_title,
        autotrader: Number(autotraderCount) > 0 ? 'Active' : 'None',
        
        // Generates the "Assets" bar data
        // In a real app, you'd calculate this from user_balances_snapshots per currency
        assets: [
          { color: '#4ade80', pct: 70 }, // USDT
          { color: '#60a5fa', pct: 30 }, // Others
        ],
      };
    });

    return c.json({
      data: formattedData,
      pagination: {
        total: formattedData.length, // Ideally use the totalResult count from before
        limit: q.limit,
        offset: q.offset,
      },
    });
  }
);

export default userRouter;
