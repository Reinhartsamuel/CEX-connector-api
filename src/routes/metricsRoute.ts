import { Hono } from 'hono';
import { metricsRegistry } from '../utils/metrics';

const metricsRouter = new Hono();

metricsRouter.get('/', async (c) => {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const auth = c.req.header('Authorization');
    if (auth !== `Bearer ${token}`) {
      return c.text('Unauthorized', 401);
    }
  }

  const metrics = await metricsRegistry.metrics();
  return c.text(metrics, 200, { 'Content-Type': metricsRegistry.contentType });
});

export default metricsRouter;
