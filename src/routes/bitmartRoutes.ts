import { Hono } from 'hono';
import { BitmartHandler } from '../handlers/bitmart/bitmartHandler';

const bitmartRouter = new Hono();

// POST /bitmart/register-user — Register a new BitMart exchange account
bitmartRouter.post('/register-user', (c) => BitmartHandler.registerUser(c));

// POST /bitmart/order — Place an order via the handler (testing/debugging)
bitmartRouter.post('/order', (c) => BitmartHandler.order(c));

// POST /bitmart/cancel-order — Cancel an order
bitmartRouter.post('/cancel-order', (c) => BitmartHandler.cancelOrder(c));

// POST /bitmart/close-position — Close all positions for a contract (DB-only, for testing)
bitmartRouter.post('/close-position', (c) => BitmartHandler.closePositionDb(c));

// POST /bitmart/playground — Generic API tester for BitMart endpoints
bitmartRouter.post('/playground', (c) => BitmartHandler.playground(c));

export default bitmartRouter;