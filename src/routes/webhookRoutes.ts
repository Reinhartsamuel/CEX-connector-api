import { Hono } from 'hono';
import { SignalHandler } from '../handlers/signalHandler';

const webhookRouter = new Hono();

// POST /webhook/signal — single entry point for all exchange signal execution
// No JWT auth — authenticated via per-autotrader webhook_token in body
webhookRouter.post('/signal', SignalHandler.handleSignal);

export default webhookRouter;
