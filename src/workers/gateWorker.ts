import { get } from "../utils/cache";
import { createGateWebSocketWithReconnect, listenToWebSocket } from "../utils/websocket";

// Start WebSocket connection alongside Hono server
async function startGateWsWorker() {
  try {
    const credentials = {
      key: process.env.GATE_API_KEY || '',
      secret: process.env.GATE_API_SECRET || ''
    };

    if (!credentials.key || !credentials.secret) {
      console.log('⚠️  WebSocket: No API credentials found, skipping WebSocket connection');
      return;
    }

    console.log('🔌 Starting WebSocket connection...');
    const ws = await createGateWebSocketWithReconnect(
      credentials,
      'futures.orders',
      'subscribe',
      ['16778193', 'DOGE_USDT'],
      'wss://fx-ws.gateio.ws/v4/ws/usdt',
      () => {
        console.log('🔄 WebSocket reconnected successfully');
      }
    );

    listenToWebSocket(ws, (data) => {
      console.log('📊 WEBSOCKETTTTT update:', data);
      if (data?.event === 'update' &&  data?.channel === 'futures.orders') {
        console.log(`📊 Processing ${data.result?.length || 0} trade updates`);
        Promise.all(data.result.map(async(trade:any) => {
          console.log(`📊 Trade ${trade.id} status: ${trade?.status}`);
          const cachedTrade = get(`trade:${trade.id}`);
          console.log(`📊 Cached trade data:`, cachedTrade);

          // Handle different status types
          if (trade?.status === 'open' || trade?.status === 'finished' || trade?.status === 'cancelled') {
            if (
              cachedTrade?.take_profit?.enabled === true &&
              cachedTrade?.take_profit?.executed === false &&
              trade?.status === 'finished' &&
              trade?.finish_as === 'filled'
            ) {
              console.log(`✅ post take_profit for trade ${trade.id} since status is ${trade?.status}`)
            }
            if (
              cachedTrade?.stop_loss?.enabled === true &&
              cachedTrade?.stop_loss?.executed === false &&
              trade?.status === 'finished' &&
              trade?.finish_as === 'filled'
            ) {
              console.log(`✅ post stop_loss for trade ${trade.id} since status is ${trade.status}`)
            }
          } else {
            console.log(`⚠️ Unknown trade status: ${trade?.status} for trade ${trade.id}`);
          }
        }))
      } else if (data?.event === 'pong') {
        console.log('🏓 Received pong from server, connection is alive');
      }
    }, (error) => {
      console.error('❌ WebSocket error:', error);
    });

    console.log('✅ WebSocket connection established');
  } catch (error) {
    console.error('❌ Failed to start WebSocket:', error);
  }
}

// Start WebSocket in background - now handled by gateWorkerRunner.ts
startGateWsWorker();
