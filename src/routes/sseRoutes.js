import { Hono } from 'hono';
import Redis from 'ioredis';
const sseRouter = new Hono();
sseRouter.get('/sse/orders/:userId', async (c) => {
    const userId = c.req.param('userId');
    const res = c.body(new ReadableStream({
        async start(controller) {
            const sub = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
            await sub.subscribe(`user:${userId}:orders:chan`);
            sub.on('message', (_ch, message) => {
                controller.enqueue(`data: ${message}\n\n`);
            });
            c.req.raw.signal.addEventListener('abort', async () => {
                await sub.unsubscribe(`user:${userId}:orders:chan`);
                sub.disconnect();
                controller.close();
            }, { once: true });
        }
    }), 200, { 'Content-Type': 'text/event-stream' });
    return res;
});
export default sseRouter;
