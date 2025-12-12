import { Database } from 'bun:sqlite';

// Initialize SQLite database
const db = new Database('cache.db');

// Create cache table if it doesn't exist
db.run(`
  CREATE TABLE IF NOT EXISTS cache (
      k TEXT PRIMARY KEY,
      v TEXT,
      exp INTEGER
    )
`);

// Create index for expiration cleanup
db.run('CREATE INDEX IF NOT EXISTS idx_cache_exp ON cache(exp)');

// Prepared statements for better performance
const getStmt = db.prepare('SELECT v, exp FROM cache WHERE k = ?');
const setStmt = db.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)');
const delStmt = db.prepare('DELETE FROM cache WHERE k = ?');
const hasStmt = db.prepare('SELECT exp FROM cache WHERE k = ?');
const clearStmt = db.prepare('DELETE FROM cache');
const cleanupStmt = db.prepare('DELETE FROM cache WHERE exp < ?');
const countStmt = db.prepare('SELECT COUNT(*) as count FROM cache');
const expiredCountStmt = db.prepare('SELECT COUNT(*) as count FROM cache WHERE exp < ?');

// Prepared statements to fetch all entries
const allStmt = db.prepare('SELECT k, v, exp FROM cache');
const nonExpiredStmt = db.prepare('SELECT k, v, exp FROM cache WHERE exp IS NULL OR exp >= ?');

/**
 * Get a value from cache
 * @param key Cache key
 * @returns Cached value or null if not found/expired
 */
export const get = (key: string): any => {
  const row = getStmt.get(key) as { v: string; exp: number | null } | null;

  if (!row) {
    return null;
  }

  // Check if the cache entry has expired (only if exp is not null)
  if (row.exp !== null && Date.now() >= row.exp) {
    // Auto-delete expired entry
    delStmt.run(key);
    return null;
  }

  try {
    return JSON.parse(row.v);
  } catch (error) {
    console.error(`Failed to parse cached value for key "${key}":`, error);
    return null;
  }
};

/**
 * Set a value in cache
 * @param key Cache key
 * @param value Value to cache (will be JSON stringified)
 * @param ttl Time to live in milliseconds (default: 5 minutes). Set to null for persistent storage.
 */
export const set = (key: string, value: any, ttl: number | null = 300_000): void => {
  try {
    const serializedValue = JSON.stringify(value);
    const expiration = ttl === null ? null : Date.now() + ttl;

    setStmt.run(key, serializedValue, expiration);
  } catch (error) {
    console.error(`Failed to cache value for key "${key}":`, error);
  }
};

/**
 * Delete a value from cache
 * @param key Cache key
 */
export const del = (key: string): void => {
  delStmt.run(key);
};

/**
 * Check if a key exists in cache (and is not expired)
 * @param key Cache key
 * @returns boolean indicating if key exists and is valid
 */
export const has = (key: string): boolean => {
  const row = hasStmt.get(key) as { exp: number | null } | null;

  if (!row) {
    return false;
  }

  if (row.exp !== null && Date.now() >= row.exp) {
    // Auto-delete expired entry
    delStmt.run(key);
    return false;
  }

  return true;
};

/**
 * Clear all cache entries
 */
export const clear = (): void => {
  clearStmt.run();
};

/**
 * Clean up expired cache entries
 * @returns Number of deleted entries
 */
export const cleanup = (): number => {
  const result = cleanupStmt.run(Date.now());
  return result.changes || 0;
};

/**
 * Get cache statistics
 * @returns Object with cache statistics
 */
export const stats = (): { total: number; expired: number; persistent: number } => {
  const total = countStmt.get() as { count: number };
  const expired = expiredCountStmt.get(Date.now()) as { count: number };
  const persistent = db.prepare('SELECT COUNT(*) as count FROM cache WHERE exp IS NULL').get() as { count: number };

  return {
    total: total.count,
    expired: expired.count,
    persistent: persistent.count
  };
};

/**
 * Return all cache entries (including expired). Parses JSON values.
 * Each entry: { key, value, exp, expired }
 */
export const getAll = (): { key: string; value: any; exp: number | null; expired: boolean }[] => {
  const rows = allStmt.all() as { k: string; v: string; exp: number | null }[];
  const now = Date.now();

  return rows.map(row => {
    let parsed: any = null;
    try {
      parsed = JSON.parse(row.v);
    } catch (e) {
      console.error(`Failed to parse cached value for key "${row.k}":`, e);
    }
    const expired = row.exp !== null && now >= row.exp;
    return { key: row.k, value: parsed, exp: row.exp, expired };
  });
};

/**
 * Return only valid (non-expired) cache entries.
 * If `autoCleanupExpired` is true, performs cleanup() to remove expired records from the DB.
 * Each entry: { key, value, exp }
 */
export const allValid = (autoCleanupExpired = true): { key: string; value: any; exp: number | null }[] => {
  const rows = nonExpiredStmt.all(Date.now()) as { k: string; v: string; exp: number | null }[];
  const result = rows.map(row => {
    let parsed: any = null;
    try {
      parsed = JSON.parse(row.v);
    } catch (e) {
      console.error(`Failed to parse cached value for key "${row.k}":`, e);
    }
    return { key: row.k, value: parsed, exp: row.exp };
  });

  if (autoCleanupExpired) {
    // Remove expired entries (side-effect)
    cleanup();
  }

  return result;
};

// Auto-cleanup on startup
cleanup();

// Export the database instance for advanced usage
export { db };
