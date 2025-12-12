// src/workers/gateWorkerRunner.ts
import WebSocket from "ws";
import Redis from "ioredis";
import JSONbig from "json-bigint";
import { signWebSocketRequest } from "../utils/signRequest";
import { WebSocketMessage } from "../schemas/interfaces";
import { postgresDb } from "../db/client";
import { trades } from "../db/schema";
import { eq } from "drizzle-orm";



// NB: implement actual Gate WS auth in buildGateWsUrl() per Gate docs.
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const control = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const CTRL_CHANNEL = "ws-control";

// in-memory map for connections
const connections = new Map<
  string,
  { ws: WebSocket | null; backoff: number }
>();

console.log("Worker: subscribing to control channel", CTRL_CHANNEL);
(async () => {
  await control.subscribe(CTRL_CHANNEL);
  control.on("message", async (_chan, msg) => {
    try {
      const cmd = JSON.parse(msg);
      if (cmd.op === "open" && cmd.userId) {
        ensureConnection(cmd.userId, cmd.contract);
      } else if (cmd.op === "close" && cmd.userId) {
        closeConnection(cmd.userId);
      }
    } catch (e) {
      console.error("Invalid control message", msg, e);
    }
  });
})();

// fetch stored credentials for the user from Redis (gate:creds:{userId})
async function fetchCreds(userId: string) {
  const creds = await redis.hgetall(`gate:creds:${userId}`);
  if (!creds || !creds.apiKey || !creds.apiSecret) return null;
  return { apiKey: creds.apiKey, apiSecret: creds.apiSecret };
}

async function ensureConnection(userId: string, contract?: string) {
  if (connections.has(userId) && connections.get(userId)!.ws) {
    console.log(`Worker: connection already exists for user ${userId}`);
    return;
  }

  const creds = await fetchCreds(userId);
  if (!creds) {
    console.warn(`Worker: no credentials for user ${userId}`);
    return;
  }

  const wsUrl = "wss://fx-ws.gateio.ws/v4/ws/usdt";
  const ws = new WebSocket(wsUrl);
  const state = { ws: null as WebSocket | null, backoff: 1000 };
  connections.set(userId, state);

  ws.on("open", () => {
    console.log(`Worker: ws open for user ${userId}`);
    state.backoff = 1000;
    const authOrders = signWebSocketRequest(
      {
        key: creds ? creds.apiKey : '',
        secret:creds ? creds.apiSecret : '',
      },
      {
        channel: "futures.orders",
        event: "subscribe",
        timestamp: Math.floor(Date.now() / 1000),
      },
    );
    // Subscribe per Gate docs — the payload here uses userId and contract (or '!all')
    const subscribeOrdersMsg: WebSocketMessage = {
      time: Math.floor(Date.now() / 1000),
      channel: "futures.orders",
      event: "subscribe",
      // payload: [String(userId), contract || '!all'],
      payload: ["16778193", "DOGE_USDT"],
      auth:authOrders,
      // auth: per Gate docs: method, KEY, SIGN if needed (implement if Gate docs requires it)
    };
    ws.send(JSON.stringify(subscribeOrdersMsg));
    console.log(`📡 Sent: chanel futures.orders and event subscribe!!!!`,subscribeOrdersMsg);


    const authPositions = signWebSocketRequest(
      {
        key: creds ? creds.apiKey : '',
        secret:creds ? creds.apiSecret : '',
      },
      {
        channel: "futures.positions",
        event: "subscribe",
        timestamp: Math.floor(Date.now() / 1000),
      },
    );
    // Subscribe per Gate docs — the payload here uses userId and contract (or '!all')
    const subscribePositionsMsg: WebSocketMessage = {
      time: Math.floor(Date.now() / 1000),
      channel: "futures.positions",
      event: "subscribe",
      // payload: [String(userId), contract || '!all'],
      payload: ["16778193", "DOGE_USDT"],
      auth:authPositions,
      // auth: per Gate docs: method, KEY, SIGN if needed (implement if Gate docs requires it)
    };
    ws.send(JSON.stringify(subscribePositionsMsg));
    console.log(`📡 Sent: chanel futures.positions and event subscribe!!!!`,subscribePositionsMsg);

    // Start ping interval to keep connection alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        const pingMessage: WebSocketMessage = {
          time: Math.floor(Date.now() / 1000),
          channel: 'futures.ping',
          event: 'ping',
        };
        ws.send(JSON.stringify(pingMessage));
        console.log('🏓 Sent ping to keep connection alive');

        // Set a timeout to detect if pong doesn't come back
        if ((ws as any).pongTimeout) {
          clearTimeout((ws as any).pongTimeout);
        }
        (ws as any).pongTimeout = setTimeout(() => {
          console.log('⚠️ No pong response received, connection may be stale');
          ws.close();
        }, 10000); // Wait 10 seconds for pong response
      } else {
        clearInterval(pingInterval);
      }
    }, 30000); // Send ping every 30 seconds

    // Store ping interval on WebSocket for cleanup
    (ws as any).pingInterval = pingInterval;

    // Start heartbeat AFTER resolving the promise
    setupHeartbeat(ws);
  });

  ws.on("message", async (raw: Buffer) => {
    // parse with json-bigint to preserve large ids
    let parsed: any;
    try {
      parsed = JSONbig.parse(raw.toString());
    } catch (err) {
      console.error("Worker: json-bigint parse failed", err);
      return;
    }


    // Gate's orders payload may be under parsed.payload / parsed.result / parsed.params[0] depending on message shape
    // Try common shapes:
    const payload = parsed.result || parsed.params?.[0] || parsed.data || parsed;
    if (!payload) return;


    // Determine message type based on channel
    const channel = parsed.channel;

    // payload might be a single order or array
    const items = Array.isArray(payload) ? payload : [payload];


    if (channel === "futures.orders") {
      console.log(`✅✅✅ RECEIVED 🅾🅡🅓🅴🅡 futures.orders ✅✅✅ ${JSON.stringify(parsed,null,2)}`)
      // Handle order updates
      await Promise.all(
        items.map(async (item: any) => {
          const orderId = String(item.id_string ?? item.order_id ?? item.trade_id ?? "unknown");
          await redis.hset(`user:${userId}:orders`, orderId, JSON.stringify(item));
          await redis.publish(`user:${userId}:orders:chan`, JSON.stringify(item));
        })
      );
    } else if (channel === "futures.positions") {
      console.log(`✅✅✅ RECEIVED 🅿🅾🅢ℹ🆃ℹ🅾🅝🅢 futures.positions ✅✅✅ ${JSON.stringify(parsed,null,2)}`)
      // Handle position updates
      await Promise.all(
        items.map(async (item: any) => {
          const positionId = String(item.id ?? item.position_id ?? item.contract ?? "unknown");
          await redis.hset(`user:${userId}:positions`, positionId, JSON.stringify(item));
          await redis.publish(`user:${userId}:positions:chan`, JSON.stringify(item));
        })
      );
    } else {
      if (channel !== 'futures.pong') {console.log('❌❌❌UKNOWN CHANNEL!!❌❌::::',parsed)}
    }
  });

  ws.on("close", (code: number, reason: Buffer) => {
    console.warn(
      `Worker: ws closed for user ${userId}, code=${code}`,
      reason?.toString?.() || reason,
    );
    state.ws = null;
    connections.delete(userId);
    // reconnect with backoff
    setTimeout(() => ensureConnection(userId, contract), state.backoff);
    state.backoff = Math.min(state.backoff * 1.5, 60000);
  });

  ws.on("error", (err: Error) => {
    console.error(`Worker: ws error for ${userId}`, err);
    // Let close handler manage reconnectionw
  });

  state.ws = ws;
}

function closeConnection(userId: string) {
  const st = connections.get(userId);
  if (!st) return;
  if (st.ws) st.ws.close();
  connections.delete(userId);
}

// graceful exit
process.on("SIGINT", () => {
  console.log("Worker: SIGINT, closing connections...");
  for (const [uid, st] of Array.from(connections.entries())) {
    if (st.ws) st.ws.terminate();
  }
  process.exit(0);
});

// In your WebSocket connection code, add this:
function setupHeartbeat(ws: WebSocket) {
  const heartbeatInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      // Send a simple subscribe message to keep connection alive
      const heartbeatMsg = JSON.stringify({
        time: Math.floor(Date.now() / 1000),
        channel: 'futures.orders',
        event: 'subscribe',
        payload: ['16778193', 'DOGE_USDT'] // or your actual user/contract
      });
      ws.send(heartbeatMsg);
    }
  }, 45000); // 45 seconds (less than typical 60s timeout)

  ws.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  return heartbeatInterval;
}
