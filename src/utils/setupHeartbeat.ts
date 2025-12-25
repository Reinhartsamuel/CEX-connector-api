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
