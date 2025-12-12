# Byscript Connector API

A comprehensive API connector for cryptocurrency trading across multiple exchanges. Currently supports Gate.io with plans to expand to OKX, Binance, and other major exchanges.

## 🏗️ New Architecture (v2.0)

The API now features a Redis-controlled WebSocket architecture for real-time order tracking:

- **Separate Processes**: Hono API and WebSocket workers run independently via PM2
- **Redis Control Channel**: Workers open connections on-demand based on control messages
- **BigInt Preservation**: Uses json-bigint to preserve large order IDs
- **Real-time SSE**: Server-Sent Events for frontend order updates
- **Scalable**: Multiple worker instances can be scaled horizontally

## 🚀 Features

- **Multi-Exchange Support**: Currently supports Gate.io futures trading
- **Automated Order Management**: Place, close, and cancel futures orders
- **Risk Management**: Built-in take profit and stop loss functionality
- **Leverage Management**: Dynamic leverage and margin mode configuration
- **RESTful API**: Clean, well-documented endpoints
- **TypeScript**: Full type safety with Zod validation
- **Security**: HMAC signature authentication for exchange APIs
- **Real-time WebSocket**: Redis-controlled WebSocket workers for order tracking
- **Server-Sent Events**: Real-time order updates via SSE
- **Scalable Architecture**: PM2-based process management with horizontal scaling

## 📋 Prerequisites

- [Bun](https://bun.sh/) (v1.0.0 or higher)
- [Redis](https://redis.io/) server (for WebSocket control and real-time data)
- [PM2](https://pm2.keymetrics.io/) (for production process management)
- Gate.io API credentials (API Key and Secret)

## 🛠 Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd byscript-connector-api
```

2. Install dependencies:
```bash
bun install
```

3. Start Redis server:
```bash
docker run -p 6379:6379 redis
```

4. Development mode (run in separate terminals):
```bash
# Terminal 1: Hono API
bun run src/index.ts

# Terminal 2: WebSocket Worker
bun run src/workers/gateWorkerRunner.ts
```

5. Production mode with PM2:
```bash
pm2 start ecosystem.config.js
```

The API will be available at `http://localhost:1122`

## 📚 API Endpoints

### Gate.io Futures Trading

#### Place Futures Order
**POST** `/gate/place-futures-order`

Place a new futures order with optional take profit and stop loss. This endpoint automatically:
- Stores user credentials in Redis
- Publishes WebSocket control message
- Triggers real-time order tracking

**Headers:**
- `api-key`: Your Gate.io API key (required)
- `api-secret`: Your Gate.io API secret (required)

**Request Body:**
```json
{
  "userId": "unique_user_id_123",
  "market_type": "market|limit",
  "price": 50000.0,
  "contract": "BTC_USDT",
  "leverage": 10,
  "leverage_type": "ISOLATED|CROSS",
  "size": 1000,
  "position_type": "long|short",
  "take_profit": {
    "enabled": true,
    "price": "52000",
    "price_type": "mark|index|last"
  },
  "stop_loss": {
    "enabled": true,
    "price": "48000",
    "price_type": "mark|index|last"
  }
}
```

**Response:**
```json
{
  "message": "ok",
  "data": {
    "resPlaceOrder": { ... },
    "take_profit": { ... },
    "stop_loss": { ... }
  }
}
```

#### Close Futures Position
**POST** `/gate/close-futures-order`

Close an existing futures position.

**Headers:**
- `api-key`: Your Gate.io API key (required)
- `api-secret`: Your Gate.io API secret (required)

**Request Body:**
```json
{
  "contract": "BTC_USDT",
  "auto_size": "close_long|close_short"
}
```

#### Cancel Futures Order
**DELETE** `/gate/cancel-futures-order`

Cancel an open futures order and associated TP/SL orders.

**Headers:**
- `api-key`: Your Gate.io API key (required)
- `api-secret`: Your Gate.io API secret (required)

**Query Parameters:**
- `trade_id`: The main order ID to cancel
- `tp_id`: (Optional) Take profit order ID to cancel
- `sl_id`: (Optional) Stop loss order ID to cancel

#### Get Order Details
**GET** `/gate/get-futures-order`

Retrieve details of a specific futures order.

**Headers:**
- `api-key`: Your Gate.io API key (required)
- `api-secret`: Your Gate.io API secret (required)

**Query Parameters:**
- `trade_id`: The order ID to retrieve

### Real-time Order Updates

#### Server-Sent Events (SSE)
**GET** `/sse/sse/orders/:userId`

Subscribe to real-time order updates for a specific user.

**Example:**
```bash
curl -N http://localhost:1122/sse/sse/orders/test_user_123
```

**Response Format:**
```
data: {"id": "1234567890123456789", "status": "open", ...}

data: {"id": "1234567890123456789", "status": "filled", ...}
```

## 🔧 Configuration

### Authentication

The API requires Gate.io credentials to be provided in request headers for all endpoints. Each request must include:

- `api-key`: Your Gate.io API key
- `api-secret`: Your Gate.io API secret

These headers are required for authentication and will be used to sign requests to the Gate.io API.

### Environment Variables

- `REDIS_URL`: Redis connection string (default: `redis://127.0.0.1:6379`)
- `PORT`: Hono API port (default: `1122`)
- `GATE_API_KEY`: Gate.io API key (for testing)
- `GATE_API_SECRET`: Gate.io API secret (for testing)

### Request Validation

All endpoints use Zod schemas for request validation. Invalid requests will return detailed error messages.

## 📖 Schema Definitions

### Order Placement Schema

```typescript
{
  userId: string,          // Unique user identifier for WebSocket tracking
  market_type: "market" | "limit",
  price: number,           // Entry price (0 for market orders)
  contract: string,        // Trading pair (e.g., "BTC_USDT")
  leverage: number,        // Leverage multiplier (e.g., 10 for 10x)
  leverage_type: "ISOLATED" | "CROSS",
  size: number,           // Position size (positive integer)
  position_type: "long" | "short",
  take_profit: {
    enabled: boolean,
    price: string,        // Trigger price
    price_type: "mark" | "index" | "last"
  },
  stop_loss: {
    enabled: boolean,
    price: string,        // Trigger price
    price_type: "mark" | "index" | "last"
  }
}
```

### Position Close Schema

```typescript
{
  contract: string,        // Trading pair (e.g., "BTC_USDT")
  auto_size: "close_long" | "close_short"
}
```

## 🔄 Order Flow

When placing a futures order, the system automatically:

1. **Sets Leverage**: Updates account leverage for the specified contract
2. **Configures Margin Mode**: Sets isolated or cross margin as specified
3. **Places Main Order**: Creates the entry order (market or limit)
4. **Stores Credentials**: Saves API credentials to Redis for WebSocket access
5. **Triggers WebSocket**: Publishes control message to open WebSocket connection
6. **Creates TP/SL Orders**: If enabled, sets up take profit and stop loss trigger orders
7. **Real-time Tracking**: WebSocket worker subscribes to order updates and stores them in Redis

### Market vs Limit Orders

- **Market Orders**: Use `tif: "ioc"` (Immediate or Cancel) with price "0"
- **Limit Orders**: Use `tif: "gtc"` (Good Till Canceled) with specified price

### Position Size Handling

- **Long positions**: Positive size values
- **Short positions**: Negative size values (automatically converted from positive input)

## 🛡️ Error Handling

The API provides comprehensive error handling:

- **Validation Errors**: Detailed Zod validation messages
- **API Errors**: Gate.io API error responses with status codes
- **Authentication Errors**: Missing or invalid API credentials
- **Redis Connection Errors**: WebSocket control channel failures
- **WebSocket Errors**: Connection and subscription failures

All errors return structured JSON responses with appropriate HTTP status codes.

## 🏗️ Project Structure

```
src/
├── handlers/           # Request handlers
│   ├── gate/          # Gate.io specific handlers
│   └── okx/           # OKX handlers (future)
├── middleware/         # Express middleware
├── routes/            # API route definitions
├── schemas/           # Zod validation schemas
├── services/          # Exchange service integrations
├── utils/             # Utility functions
└── workers/           # WebSocket workers
    ├── gateWorkerRunner.ts    # Redis-controlled worker
    └── gateWorker.ts          # Legacy worker (archived)
```

## 🚀 Production Deployment

### PM2 Process Management

The API uses PM2 for production process management:

```bash
# Start all services
pm2 start ecosystem.config.js

# Scale WebSocket workers
pm2 scale gate-worker 4

# Monitor services
pm2 status
pm2 logs

# Restart services
pm2 restart all
```

### Architecture Overview

- **Hono API**: Handles HTTP requests, stores credentials, publishes control messages
- **Gate Worker**: Subscribes to Redis control channel, manages per-user WebSocket connections
- **Redis**: Central message bus for control messages and real-time data storage
- **SSE**: Provides real-time order updates to frontend clients

### WebSocket Control Flow

1. **Order Placement** → Hono API stores credentials and publishes `{op: 'open', userId, contract}`
2. **Control Message** → Redis pub/sub delivers message to all workers
3. **WebSocket Connection** → Worker opens Gate.io WebSocket for the user
4. **Order Updates** → Worker stores snapshots in Redis and publishes SSE events
5. **Real-time Updates** → Frontend receives updates via SSE endpoint

## 🔐 Authentication & Security

### HMAC Signature Generation

The API uses HMAC-SHA512 signatures for secure communication with Gate.io. The signature process:

1. **Timestamp**: Current Unix timestamp in seconds
2. **Payload Hash**: SHA512 hash of the request body
3. **Signature String**: Concatenated string in format:
   ```
   METHOD\nURL_PATH\nQUERY_STRING\nHASHED_PAYLOAD\nTIMESTAMP
   ```
4. **HMAC Signature**: HMAC-SHA512 of signature string using API secret

### Request Headers

All authenticated requests require:
- `KEY`: Your Gate.io API key
- `Timestamp`: Unix timestamp
- `SIGN`: HMAC-SHA512 signature

## 🔧 Utility Functions

### Signature Generation

```typescript
// src/utils/signRequest.ts
function signRequestRest(
  credentials: GateCredentials,
  options: SignRequestOptions
): Record<string, string>
```

**Parameters:**
- `credentials`: API key and secret
- `options`: Request method, path, query string, and payload

### Validation Error Handler

```typescript
// src/middleware/validationErrorHandler.ts
export const validationErrorHandler = (result: any, c: Context)
```

Transforms Zod validation errors into user-friendly format with detailed field-level error messages.

### WebSocket Utilities

```typescript
// src/utils/websocket.ts
function createGateWebSocket(
  credentials: GateCredentials,
  channel: string,
  event: string,
  payload?: any[]
): Promise<WebSocket>

function listenToWebSocket(
  ws: WebSocket,
  onMessage: (data: any) => void,
  onError?: (error: Error) => void
): void
```

**Features:**
- Uses json-bigint to preserve large order IDs
- Automatic reconnection with exponential backoff
- Redis-based control channel for on-demand connections

## 🔮 Future Development

Planned exchange integrations:
- ✅ Gate.io (Current)
- 🔄 OKX (In Progress)
- 📋 Binance
- 📋 Bybit
- 📋 KuCoin

Planned architecture improvements:
- 🔄 Multiple exchange WebSocket workers
- 📋 Connection pooling and load balancing
- 📋 Advanced order state management
- 📋 Historical data storage and analytics

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

[Add your license information here]

## 🧪 API Testing with Postman

A ready-to-use Postman collection is available for easy API testing:

### Setup Instructions

1. **Import Collection**:
   - Download `connector-API.postman_collection.json` from the project root
   - Open Postman and click "Import"
   - Select the downloaded JSON file

2. **Configure Environment Variables**:
   - In Postman, go to the "Environments" tab
   - Create a new environment called "Byscript API"
   - Add the following variables:
     - `baseUrl`: `http://localhost:1122` (or your deployed URL)
     - `apiKey`: Your Gate.io API key
     - `apiSecret`: Your Gate.io API secret
     - `userId`: Unique user identifier for WebSocket testing

3. **Test the API**:
   - Select the "Byscript Connector API" collection
   - Choose your environment from the dropdown
   - Start with the "Place Futures Order" request (includes new `userId` field)
   - Test the SSE endpoint for real-time updates
   - Modify request bodies as needed for your trading parameters

### Collection Features

- **Pre-configured Headers**: All requests include proper `api-key` and `api-secret` headers
- **Example Requests**: Multiple trading scenarios with realistic parameters
- **Test Scripts**: Automatic response validation
- **Environment Variables**: Easy configuration management
- **SSE Testing**: Real-time order update examples
- **WebSocket Integration**: Updated requests with `userId` field

## 🆘 Support

For issues and questions:
1. Check the API documentation
2. Review error messages in responses
3. Ensure proper API credential configuration
4. Verify contract symbols and trading parameters
5. Use the Postman collection for testing
6. Ensure Redis server is running for WebSocket functionality
7. Check PM2 logs for production deployment issues
8. Verify `userId` field is included in order placement requests

---

## 🐛 Troubleshooting

### WebSocket Issues
- **Worker not starting**: Check Redis connection and `REDIS_URL` environment variable
- **No real-time updates**: Verify `userId` matches between order placement and SSE subscription
- **Connection errors**: Check Gate.io API credentials and WebSocket endpoint

### Redis Issues
- **Connection refused**: Ensure Redis server is running on expected port
- **Control messages not delivered**: Verify Redis pub/sub channel names match
- **Credential storage failures**: Check Redis persistence and memory limits

### Production Issues
- **PM2 process crashes**: Check memory limits and restart policies
- **Scalability problems**: Scale worker instances with `pm2 scale gate-worker N`
- **Performance issues**: Monitor Redis memory usage and connection counts

---

**Note**: This is a trading API connector. Use at your own risk. Always test with small amounts first and understand the risks involved in leveraged trading.
