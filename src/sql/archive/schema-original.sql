-- PostgreSQL Schema for Byscript Connector API
-- Supports multi-exchange trading with webhook tracking and trade management

-- Users table - stores platform users
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE,
    email VARCHAR(255) UNIQUE,
    password_hash VARCHAR(255),
    name VARCHAR(100),
    is_active BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP WITH TIME ZONE
);

-- Exchanges table - users can have multiple exchange connections
CREATE TABLE IF NOT EXISTS exchanges (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exchange_title VARCHAR(100) NOT NULL, -- 'gate', 'binance', 'okx', etc.
    api_key VARCHAR(500) NOT NULL,
    api_secret VARCHAR(500) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    testnet BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, exchange_title)
);

-- Webhooks table - tracks all webhook trigger events
CREATE TABLE IF NOT EXISTS webhooks (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exchange_id BIGINT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
    action VARCHAR(100) NOT NULL, -- 'place_order', 'close_position', 'cancel_order', etc.
    payload JSONB NOT NULL, -- Original webhook payload
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'open', 'finished', 'completed', 'failed'
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Trades table - stores trade information from exchanges
CREATE TABLE IF NOT EXISTS trades (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exchange_id BIGINT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
    trade_id VARCHAR(255) NOT NULL, -- Exchange-provided trade ID
    contract VARCHAR(100) NOT NULL, -- Trading pair like 'BTC_USDT'
    position_type VARCHAR(10) NOT NULL, -- 'long' or 'short'
    market_type VARCHAR(10) NOT NULL, -- 'market' or 'limit'
    size NUMERIC(20,8) NOT NULL, -- Position size
    price NUMERIC(20,8), -- Entry price (NULL for market orders)
    leverage INTEGER NOT NULL,
    leverage_type VARCHAR(20) NOT NULL, -- 'ISOLATED' or 'CROSS'
    status VARCHAR(50) NOT NULL, -- 'open', 'filled', 'cancelled', 'closed', 'failed'
    finished_as VARCHAR(50),
    reduce_only BOOLEAN DEFAULT false,
    take_profit_enabled BOOLEAN DEFAULT false,
    take_profit_executed BOOLEAN DEFAULT false,
    take_profit_price NUMERIC(20,8),
    take_profit_price_type VARCHAR(10), -- 'mark', 'index', 'last'
    stop_loss_enabled BOOLEAN DEFAULT false,
    stop_loss_executed BOOLEAN DEFAULT false,
    stop_loss_price NUMERIC(20,8),
    stop_loss_price_type VARCHAR(10), -- 'mark', 'index', 'last'
    metadata JSONB, -- Additional trade metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(exchange_id, trade_id)
);

-- Webhook responses table - stores responses from exchange APIs
CREATE TABLE IF NOT EXISTS webhook_responses (
    id BIGSERIAL PRIMARY KEY,
    webhook_id BIGINT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exchange_id BIGINT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
    trade_id BIGINT REFERENCES trades(id) ON DELETE SET NULL,
    response_status INTEGER NOT NULL, -- HTTP status code
    response_body JSONB NOT NULL, -- Full response from exchange
    error_message TEXT,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Order updates table - stores real-time order updates from WebSocket
CREATE TABLE IF NOT EXISTS order_updates (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exchange_id BIGINT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
    trade_id BIGINT REFERENCES trades(id) ON DELETE SET NULL,
    exchange_trade_id VARCHAR(255) NOT NULL,
    update_type VARCHAR(50) NOT NULL, -- 'create', 'update', 'cancel', 'fill'
    status VARCHAR(50) NOT NULL,
    size NUMERIC(20,8),
    filled_size NUMERIC(20,8),
    price NUMERIC(20,8),
    average_price NUMERIC(20,8),
    update_data JSONB NOT NULL, -- Full update payload
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_exchanges_user_id ON exchanges(user_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_title ON exchanges(exchange_title);
CREATE INDEX IF NOT EXISTS idx_webhooks_user_id ON webhooks(user_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_exchange_id ON webhooks(exchange_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_created_at ON webhooks(created_at);
CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_exchange_id ON trades(exchange_id);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
CREATE INDEX IF NOT EXISTS idx_trades_exchange_trade_id ON trades(exchange_id, trade_id);
CREATE INDEX IF NOT EXISTS idx_webhook_responses_webhook_id ON webhook_responses(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_responses_user_id ON webhook_responses(user_id);
CREATE INDEX IF NOT EXISTS idx_order_updates_user_id ON order_updates(user_id);
CREATE INDEX IF NOT EXISTS idx_order_updates_exchange_trade_id ON order_updates(exchange_trade_id);
CREATE INDEX IF NOT EXISTS idx_order_updates_created_at ON order_updates(created_at);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for automatic updated_at updates
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_exchanges_updated_at BEFORE UPDATE ON exchanges
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_trades_updated_at BEFORE UPDATE ON trades
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE users IS 'Platform users who can connect to multiple exchanges';
COMMENT ON TABLE exchanges IS 'Exchange connections with API credentials for each user';
COMMENT ON TABLE webhooks IS 'Incoming webhook triggers for trading actions';
COMMENT ON TABLE trades IS 'Trading positions and orders placed on exchanges';
COMMENT ON TABLE webhook_responses IS 'Responses received from exchange APIs for webhook actions';
COMMENT ON TABLE order_updates IS 'Real-time order updates received via WebSocket connections';
