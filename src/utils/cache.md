# Cache Module Documentation

A lightweight SQLite-based caching solution built with Bun's built-in SQLite support.

## Overview

This cache module provides a simple, persistent caching mechanism using SQLite as the storage backend. It's designed as a lightweight alternative to Redis or Memcached for applications that don't require distributed caching.

## Features

- **Simple API**: Easy-to-use get/set operations
- **TTL Support**: Automatic expiration of cached items or persistent storage
- **Persistent Storage**: Data survives application restarts
- **Automatic Cleanup**: Expired entries are automatically removed
- **Statistics**: Get cache usage statistics
- **TypeScript Support**: Fully typed API

## Installation

The cache module is built into the project and requires no additional dependencies when using Bun.

## Usage

### Basic Operations

```typescript
import { get, set, del, has } from './cache';

// Set a value with default TTL (5 minutes)
set('user:1', { name: 'John', email: 'john@example.com' });

// Set with custom TTL (10 seconds)
set('session:abc123', sessionData, 10000);

// Set persistent cache (no expiration)
set('app:config', { version: '1.0.0' }, null);

// Get a value
const user = get('user:1');
console.log(user); // { name: 'John', email: 'john@example.com' }

// Check if key exists
if (has('user:1')) {
  console.log('Key exists');
}

// Delete a key
del('user:1');
```

### Advanced Operations

```typescript
import { clear, stats, cleanup } from './cache';

// Clear all cache entries
clear();

// Get cache statistics
const cacheStats = stats();
console.log(`Total entries: ${cacheStats.total}, Expired: ${cacheStats.expired}`);

// Manually clean up expired entries
const cleanedCount = cleanup();
console.log(`Cleaned up ${cleanedCount} expired entries`);
```

## API Reference

### `get(key: string): any`

Retrieves a value from cache. Returns `null` if the key doesn't exist or has expired.

**Parameters:**
- `key`: The cache key

**Returns:** The cached value or `null`

### `set(key: string, value: any, ttl: number = 300000): void`

Stores a value in cache.

**Parameters:**
- `key`: The cache key
- `value`: The value to cache (will be JSON stringified)
- `ttl`: Time to live in milliseconds (default: 5 minutes). Set to `null` for persistent storage.

### `del(key: string): void`

Deletes a specific key from cache.

**Parameters:**
- `key`: The cache key to delete

### `has(key: string): boolean`

Checks if a key exists in cache and is not expired.

**Parameters:**
- `key`: The cache key to check

**Returns:** `true` if key exists and is valid, `false` otherwise

### `clear(): void`

Removes all entries from cache.

### `cleanup(): number`

Manually removes expired cache entries.

**Returns:** Number of entries that were deleted

### `stats(): { total: number, expired: number }`

Returns cache statistics.

**Returns:** Object containing:
- `total`: Total number of cache entries
- `expired`: Number of expired cache entries
- `persistent`: Number of persistent cache entries (no TTL)

## Database Schema

The cache uses a simple SQLite table:

```sql
CREATE TABLE cache (
  k TEXT PRIMARY KEY,    -- Cache key
  v TEXT,                -- JSON-serialized value
  exp INTEGER            -- Expiration timestamp (milliseconds, NULL for persistent)

);
```

## Performance Notes

- Prepared statements are used for better performance
- Automatic cleanup runs on module initialization
- Expired entries are automatically removed on access
- Index on expiration timestamp for efficient cleanup

## File Location

The cache database file is created at `./cache.db` relative to your application's working directory.

## Example Use Cases

- API response caching
- Session storage
- Configuration caching
- Rate limiting counters
- Temporary data storage

## Limitations

- Not suitable for distributed systems
- Single-file database (not sharded)
- No built-in cache eviction policies (only TTL-based for non-persistent entries)

## See Also

- [Bun SQLite Documentation](https://bun.sh/docs/api/sqlite)
- [Example Usage](./cache.example.ts)