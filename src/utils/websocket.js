import { WebSocket } from 'ws';
import { signWebSocketRequest } from './signRequest';
import JSONbig from 'json-bigint';
// In your WebSocket connection code, add this:
function setupHeartbeat(ws) {
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
/**
 * Minimal WebSocket utility that matches the Go example from official docs
 */
export async function createGateWebSocket(credentials, channel, event, payload, url = 'wss://fx-ws.gateio.ws/v4/ws/usdt') {
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('WebSocket connection timeout'));
        }, 10000);
        ws.on('open', () => {
            clearTimeout(timeout);
            console.log('✅ Connected to Gate.io WebSocket');
            // Create authentication for private channels
            const auth = signWebSocketRequest(credentials, {
                channel,
                event,
                timestamp: Math.floor(Date.now() / 1000),
            });
            // Build message exactly like Go example
            const message = {
                time: Math.floor(Date.now() / 1000),
                channel,
                event,
                payload,
                auth,
            };
            // Send the message
            ws.send(JSON.stringify(message));
            console.log(`📡 Sent: ${channel} - ${event}`);
            // Start ping interval to keep connection alive
            const pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    const pingMessage = {
                        time: Math.floor(Date.now() / 1000),
                        channel: 'futures.ping',
                        event: 'ping',
                    };
                    ws.send(JSON.stringify(pingMessage));
                    console.log('🏓 Sent ping to keep connection alive');
                    // Set a timeout to detect if pong doesn't come back
                    if (ws.pongTimeout) {
                        clearTimeout(ws.pongTimeout);
                    }
                    ws.pongTimeout = setTimeout(() => {
                        console.log('⚠️ No pong response received, connection may be stale');
                        ws.close();
                    }, 10000); // Wait 10 seconds for pong response
                }
                else {
                    clearInterval(pingInterval);
                }
            }, 30000); // Send ping every 30 seconds
            // Store ping interval on WebSocket for cleanup
            ws.pingInterval = pingInterval;
            // Start heartbeat AFTER resolving the promise
            setupHeartbeat(ws);
            resolve(ws);
        });
        ws.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
}
/**
 * Simple function to listen for messages
 */
export function listenToWebSocket(ws, onMessage, onError) {
    ws.on('message', (data) => {
        try {
            const message = JSONbig.parse(data.toString());
            onMessage(message);
        }
        catch (error) {
            console.error('❌ Error parsing WebSocket message:', error);
        }
    });
    if (onError) {
        ws.on('error', onError);
    }
    ws.on('close', (code, reason) => {
        console.log(`🔌 WebSocket connection closed: ${code} - ${reason}`);
        // Clean up ping interval and pong timeout
        if (ws.pingInterval) {
            clearInterval(ws.pingInterval);
        }
        if (ws.pongTimeout) {
            clearTimeout(ws.pongTimeout);
        }
    });
}
/**
 * Send a simple message to WebSocket
 */
export function sendWebSocketMessage(ws, channel, event, payload) {
    const message = {
        time: Math.floor(Date.now() / 1000),
        channel,
        event,
        payload,
    };
    ws.send(JSON.stringify(message));
    console.log(`📡 Sent: ${channel} - ${event}`);
}
/**
 * Enhanced WebSocket connection with automatic reconnection
 */
export async function createGateWebSocketWithReconnect(credentials, channel, event, payload, url = 'wss://fx-ws.gateio.ws/v4/ws/usdt', onReconnect) {
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;
    const baseReconnectDelay = 1000; // 1 second
    const connect = async () => {
        try {
            const ws = await createGateWebSocket(credentials, channel, event, payload, url);
            ws.on('close', (code, reason) => {
                console.log(`🔌 WebSocket closed: ${code} - ${reason}`);
                // Attempt reconnection for non-normal closures
                if (code !== 1000 && reconnectAttempts < maxReconnectAttempts) {
                    const delay = baseReconnectDelay * Math.pow(2, reconnectAttempts);
                    console.log(`🔄 Reconnecting in ${delay}ms (attempt ${reconnectAttempts + 1}/${maxReconnectAttempts})`);
                    setTimeout(async () => {
                        reconnectAttempts++;
                        try {
                            await connect();
                            if (onReconnect)
                                onReconnect();
                        }
                        catch (error) {
                            console.error('❌ Reconnection failed:', error);
                        }
                    }, delay);
                }
            });
            return ws;
        }
        catch (error) {
            console.error('❌ WebSocket connection failed:', error);
            throw error;
        }
    };
    return connect();
}
/**
 * Simple usage example - matches the Go code from official docs
 */
export async function exampleUsage() {
    const credentials = {
        key: process.env.GATE_API_KEY || 'your_api_key',
        secret: process.env.GATE_API_SECRET || 'your_api_secret'
    };
    try {
        // Connect and subscribe to futures orders (exactly like Go example)
        const ws = await createGateWebSocket(credentials, 'futures.orders', 'subscribe', ['20011', 'BTC_USD']);
        // Listen for messages
        listenToWebSocket(ws, (data) => {
            console.log('📨 Received:', data);
        }, (error) => {
            console.error('❌ WebSocket error:', error);
        });
        // Keep connection alive for 30 seconds
        setTimeout(() => {
            ws.close();
            console.log('✅ Example completed');
        }, 30000);
    }
    catch (error) {
        console.error('❌ Failed to connect:', error);
    }
}
// Uncomment to run the example
// exampleUsage();
