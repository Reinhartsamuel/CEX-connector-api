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
export const get = (key) => {
    const row = getStmt.get(key);
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
    }
    catch (error) {
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
export const set = (key, value, ttl = 300000) => {
    try {
        const serializedValue = JSON.stringify(value);
        const expiration = ttl === null ? null : Date.now() + ttl;
        setStmt.run(key, serializedValue, expiration);
    }
    catch (error) {
        console.error(`Failed to cache value for key "${key}":`, error);
    }
};
/**
 * Delete a value from cache
 * @param key Cache key
 */
export const del = (key) => {
    delStmt.run(key);
};
/**
 * Check if a key exists in cache (and is not expired)
 * @param key Cache key
 * @returns boolean indicating if key exists and is valid
 */
export const has = (key) => {
    const row = hasStmt.get(key);
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
export const clear = () => {
    clearStmt.run();
};
/**
 * Clean up expired cache entries
 * @returns Number of deleted entries
 */
export const cleanup = () => {
    const result = cleanupStmt.run(Date.now());
    return result.changes || 0;
};
/**
 * Get cache statistics
 * @returns Object with cache statistics
 */
export const stats = () => {
    const total = countStmt.get();
    const expired = expiredCountStmt.get(Date.now());
    const persistent = db.prepare('SELECT COUNT(*) as count FROM cache WHERE exp IS NULL').get();
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
export const getAll = () => {
    const rows = allStmt.all();
    const now = Date.now();
    return rows.map(row => {
        let parsed = null;
        try {
            parsed = JSON.parse(row.v);
        }
        catch (e) {
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
export const allValid = (autoCleanupExpired = true) => {
    const rows = nonExpiredStmt.all(Date.now());
    const result = rows.map(row => {
        let parsed = null;
        try {
            parsed = JSON.parse(row.v);
        }
        catch (e) {
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
