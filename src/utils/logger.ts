import pino from 'pino';
import pinoLoki from 'pino-loki';
import { multistream } from 'pino';

const processName = process.env.PM2_APP_NAME ?? 'byscript';

async function buildStream(): Promise<pino.MultiStreamRes> {
  const streams: pino.StreamEntry[] = [{ stream: process.stdout }];

  const lokiUrl = process.env.LOKI_URL;
  if (lokiUrl) {
    const lokiStream = await pinoLoki({
      host: lokiUrl,
      labels: { app: 'byscript-api', process: processName },
      silenceErrors: true,
      replaceTimestamp: false,
    });
    streams.push({ stream: lokiStream as unknown as NodeJS.WritableStream });
  }

  return multistream(streams);
}

const stream = await buildStream();

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: pino.stdSerializers.err },
  },
  stream,
);

export function createLogger(bindings: Record<string, string>) {
  return logger.child(bindings);
}

export async function flushLogger(): Promise<void> {
  await new Promise<void>((resolve) => {
    stream.flushSync?.();
    setTimeout(resolve, 500); // give pino-loki time to flush its batch
  });
}
