import { Client } from "pg";


const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL) throw new Error("DATABASE_URL missing");

export const pg = new Client({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

export async function connectDB() {
  await pg.connect();
}

// Insert raw event if deduped (by content_hash). Returns row id or null.
export async function example_upsertRawEvent(event: {
  source: string;
  source_id?: string;
  title?: string;
  text: string;
  url?: string;
  metadata?: any;
  content_hash: string;
}) {
  const q = `
    INSERT INTO raw_events (source, source_id, title, text, url, metadata, content_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (content_hash) DO NOTHING
    RETURNING id, inserted_at
  `;
  const vals = [
    event.source,
    event.source_id ?? null,
    event.title ?? null,
    event.text,
    event.url ?? null,
    event.metadata ?? null,
    event.content_hash,
  ];
  const res = await pg.query(q, vals);
  if (res.rows.length === 0) return null;
  return res.rows[0];
}

export async function enqueueForSignalExtraction(rawEventId: number) {
  const q = `INSERT INTO signal_queue (raw_event_id) VALUES ($1) RETURNING id`;
  const res = await pg.query(q, [rawEventId]);
  return res.rows[0];
}
