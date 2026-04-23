import { Hono } from 'hono';
import { SignalHandler } from '../handlers/signalHandler';

const webhookRouter = new Hono();

// POST /webhook/signal — single entry point for personal exchange signal execution
// No JWT auth — authenticated via per-autotrader webhook_token in body
webhookRouter.post('/signal', SignalHandler.handleSignal);

// POST /webhook/public-signal — plan key based fanout to subscribed autotraders
webhookRouter.post('/public-signal', SignalHandler.handlePublicSignal);

export default webhookRouter;
