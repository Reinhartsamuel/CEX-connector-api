import { Hono } from 'hono';
import { MexcHandler } from '../handlers/mexc/mexcHandler';

const mexcRouter = new Hono();

// POST /mexc/register-user — Register a new MEXC exchange account
mexcRouter.post('/register-user', (c) => MexcHandler.registerUser(c));

// POST /mexc/order — Place an order via the handler (testing/debugging)
mexcRouter.post('/order', (c) => MexcHandler.order(c));

// POST /mexc/cancel-order — Cancel an order
mexcRouter.post('/cancel-order', (c) => MexcHandler.cancelOrder(c));

// POST /mexc/close-position — Close all positions for a contract (DB-only, for testing)
mexcRouter.post('/close-position', (c) => MexcHandler.closePositionDb(c));

// POST /mexc/playground — Generic API tester for MEXC endpoints
mexcRouter.post('/playground', (c) => MexcHandler.playground(c));

export default mexcRouter;