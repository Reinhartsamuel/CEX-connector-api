import { Hono } from 'hono';
import { BitgetHandler } from '../handlers/bitget/bitgetHandler';

const bitgetRouter = new Hono();

// POST /bitget/register-user — Register a new Bitget exchange account
bitgetRouter.post('/register-user', (c) => BitgetHandler.registerUser(c));

// POST /bitget/order — Place an order via the handler (testing/debugging)
bitgetRouter.post('/order', (c) => BitgetHandler.order(c));

// POST /bitget/cancel-order — Cancel an order
bitgetRouter.post('/cancel-order', (c) => BitgetHandler.cancelOrder(c));

// POST /bitget/close-position — Close all positions for a contract (DB-only, for testing)
bitgetRouter.post('/close-position', (c) => BitgetHandler.closePositionDb(c));

// POST /bitget/playground — Generic API tester for Bitget endpoints
bitgetRouter.post('/playground', (c) => BitgetHandler.playground(c));

export default bitgetRouter;