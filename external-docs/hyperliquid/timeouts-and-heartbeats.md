# Timeouts and heartbeats

The server will close any connection if it hasn't sent a message to it in the last 60 seconds. If you are subscribing to a channel that doesn't receive messages every 60 seconds, you can send heartbeat messages to keep your connection alive. The format for these messages are:

```json
{ "method": "ping" }
```

The server will respond with:

```json
{ "channel": "pong" }
```