import { pgTable, serial, boolean, timestamp, text, integer, numeric, jsonb, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
// Users table - stores platform users
export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    username: text('username').unique(),
    email: text('email').notNull().unique(),
    name: text('name'),
    is_active: boolean('is_active').default(true),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
    last_login_at: timestamp('last_login_at', { withTimezone: true }),
    firebase_uid: text('firebase_uid')
});
// Exchanges table - users can have multiple exchange connections
export const exchanges = pgTable('exchanges', {
    id: serial('id').primaryKey(),
    user_id: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    exchange_title: text('exchange_title').notNull(), // 'gate', 'binance', 'okx', etc.
    market_type: text('market_type'), // "futures" | "spot"
    api_key: text('api_key').notNull(),
    api_secret: text('api_secret').notNull(),
    is_active: boolean('is_active').default(true),
    testnet: boolean('testnet').default(false),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
    // for existing 3commas users
    exchange_external_id: text('exchange_external_id'),
    exchange_external_name: text('exchange_external_name'),
    market_code: text('market_code'),
}, (table) => {
    return {
        unique_user_exchange: unique().on(table.user_id, table.exchange_title),
    };
});
// Webhooks table - tracks all webhook trigger events
export const webhooks = pgTable('webhooks', {
    id: serial('id').primaryKey(),
    user_id: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    exchange_id: integer('exchange_id').notNull().references(() => exchanges.id, { onDelete: 'cascade' }),
    action: text('action').notNull(), // 'place_order', 'close_position', 'cancel_order', etc.
    payload: jsonb('payload').notNull(), // Original webhook payload
    status: text('status').default('pending'), // 'pending', 'open', 'finished', 'completed', 'failed'
    type: text('type').default('subscription'), // 'subscription', 'personal'
    processed_at: timestamp('processed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
// Trades table - stores trade information from exchanges
export const trades = pgTable('trades', {
    id: serial('id').primaryKey(),
    user_id: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    exchange_id: integer('exchange_id').notNull().references(() => exchanges.id, { onDelete: 'cascade' }),
    trade_id: text('trade_id').notNull(), // Exchange-provided trade ID
    order_id: text('order_id').notNull(), // Exchange-provided trade ID
    open_order_id: text('open_order_id').notNull(), // Exchange-provided trade ID
    open_fill_price: text('open_fill_price'), // price executed when filled.
    open_filled_at: integer('open_filled_at'), // timestamp
    close_order_id: text('close_order_id'),
    close_filled_at: integer('close_filled_at'),
    close_reason: text('close_reason'),
    contract: text('contract').notNull(), // Trading pair like 'BTC_USDT'
    position_type: text('position_type').notNull(), // 'long' or 'short'
    market_type: text('market_type').notNull(), // 'market' or 'limit'
    size: numeric('size', { precision: 20, scale: 8 }).notNull(), // Position size
    price: numeric('price', { precision: 20, scale: 8 }), // Entry price (NULL for market orders)
    leverage: integer('leverage').notNull(),
    leverage_type: text('leverage_type').notNull(), // 'ISOLATED' or 'CROSS'
    pnl: numeric('pnl', { precision: 28, scale: 12 }),
    pnl_margin: numeric('pnl_margin', { precision: 28, scale: 12 }),
    status: text('status').notNull(), // 'open', 'filled', 'cancelled', 'closed', 'failed'
    position_status: text('position_status'),
    closed_at: timestamp('closed_at', { withTimezone: true }),
    reduce_only: boolean('reduce_only').default(false),
    take_profit_enabled: boolean('take_profit_enabled').default(false),
    take_profit_executed: boolean('take_profit_executed').default(false),
    take_profit_price: numeric('take_profit_price', { precision: 20, scale: 8 }),
    take_profit_price_type: text('take_profit_price_type'), // 'mark', 'index', 'last'
    stop_loss_enabled: boolean('stop_loss_enabled').default(false),
    stop_loss_executed: boolean('stop_loss_executed').default(false),
    stop_loss_price: numeric('stop_loss_price', { precision: 20, scale: 8 }),
    stop_loss_price_type: text('stop_loss_price_type'), // 'mark', 'index', 'last'
    metadata: jsonb('metadata'), // Additional trade metadata
    is_tpsl: boolean('is_tpsl').default(false), // if this is principal trade then false, if TP or SL order then true
    tpsl_type: text('tpsl_type'),
    parent_trade_id: integer('parent_trade_id'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => {
    return {
        unique_exchange_trade: unique().on(table.exchange_id, table.trade_id),
    };
});
// 2. 👇 Add the foreign key constraint separately using relations
export const tradesRelations = relations(trades, ({ one, many }) => ({
    parentTrade: one(trades, {
        fields: [trades.parent_trade_id],
        references: [trades.id],
        relationName: 'parent_child_trade',
    }),
    childTrades: many(trades, {
        relationName: 'parent_child_trade',
    }),
}));
// Webhook responses table - stores responses from exchange APIs
export const webhook_responses = pgTable('webhook_responses', {
    id: serial('id').primaryKey(),
    webhook_id: integer('webhook_id').notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
    user_id: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    exchange_id: integer('exchange_id').notNull().references(() => exchanges.id, { onDelete: 'cascade' }),
    trade_id: integer('trade_id').references(() => trades.id, { onDelete: 'set null' }),
    response_status: integer('response_status').notNull(), // HTTP status code
    response_body: jsonb('response_body').notNull(), // Full response from exchange
    error_message: text('error_message'),
    processed_at: timestamp('processed_at', { withTimezone: true }).defaultNow(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
    raw: jsonb('raw')
});
// Order updates table - stores real-time order updates from WebSocket
export const order_updates = pgTable('order_updates', {
    id: serial('id').primaryKey(),
    user_id: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    exchange_id: integer('exchange_id').notNull().references(() => exchanges.id, { onDelete: 'cascade' }),
    trade_id: integer('trade_id').references(() => trades.id, { onDelete: 'set null' }),
    exchange_trade_id: text('exchange_trade_id').notNull(),
    update_type: text('update_type').notNull(), // 'create', 'update', 'cancel', 'fill'
    status: text('status').notNull(),
    size: numeric('size', { precision: 20, scale: 8 }),
    filled_size: numeric('filled_size', { precision: 20, scale: 8 }),
    price: numeric('price', { precision: 20, scale: 8 }),
    average_price: numeric('average_price', { precision: 20, scale: 8 }),
    update_data: jsonb('update_data').notNull(), // Full update payload
    metadata: jsonb('metadata'), // Additional trade metadata
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
// Define relations
export const users_relations = relations(users, ({ many }) => ({
    exchanges: many(exchanges),
    webhooks: many(webhooks),
    trades: many(trades),
    webhook_responses: many(webhook_responses),
    order_updates: many(order_updates),
}));
export const exchanges_relations = relations(exchanges, ({ one, many }) => ({
    user: one(users, {
        fields: [exchanges.user_id],
        references: [users.id],
    }),
    webhooks: many(webhooks),
    trades: many(trades),
    webhook_responses: many(webhook_responses),
    order_updates: many(order_updates),
}));
export const webhooks_relations = relations(webhooks, ({ one, many }) => ({
    user: one(users, {
        fields: [webhooks.user_id],
        references: [users.id],
    }),
    exchange: one(exchanges, {
        fields: [webhooks.exchange_id],
        references: [exchanges.id],
    }),
    webhook_responses: many(webhook_responses),
}));
export const trades_relations = relations(trades, ({ one, many }) => ({
    user: one(users, {
        fields: [trades.user_id],
        references: [users.id],
    }),
    exchange: one(exchanges, {
        fields: [trades.exchange_id],
        references: [exchanges.id],
    }),
    webhook_responses: many(webhook_responses),
    order_updates: many(order_updates),
}));
export const webhook_responses_relations = relations(webhook_responses, ({ one }) => ({
    webhook: one(webhooks, {
        fields: [webhook_responses.webhook_id],
        references: [webhooks.id],
    }),
    user: one(users, {
        fields: [webhook_responses.user_id],
        references: [users.id],
    }),
    exchange: one(exchanges, {
        fields: [webhook_responses.exchange_id],
        references: [exchanges.id],
    }),
    trade: one(trades, {
        fields: [webhook_responses.trade_id],
        references: [trades.id],
    }),
}));
export const order_updates_relations = relations(order_updates, ({ one }) => ({
    user: one(users, {
        fields: [order_updates.user_id],
        references: [users.id],
    }),
    exchange: one(exchanges, {
        fields: [order_updates.exchange_id],
        references: [exchanges.id],
    }),
    trade: one(trades, {
        fields: [order_updates.trade_id],
        references: [trades.id],
    }),
}));
