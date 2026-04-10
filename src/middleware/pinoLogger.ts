import type { MiddlewareHandler } from 'hono';
import { createLogger } from '../utils/logger';

const httpLog = createLogger({ process: 'api', component: 'http' });

export const pinoLoggerMiddleware: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  httpLog.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      latency_ms: Date.now() - start,
    },
    'request',
  );
};
