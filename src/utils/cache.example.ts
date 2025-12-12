import { get, set, del, has, clear, stats, cleanup } from './cache';

// Example 1: Basic caching
console.log('=== Basic Caching Example ===');
const userData = { id: 1, name: 'John Doe', email: 'john@example.com' };

// Set cache with 10 second TTL
set('user:1', userData, 10000);
console.log('Set user data in cache');

// Get from cache
const cachedUser = get('user:1');
console.log('Retrieved from cache:', cachedUser);

// Check if key exists
console.log('Key exists:', has('user:1'));

// Example 2: Cache with different TTL
console.log('\n=== Different TTL Example ===');
set('config:app', { theme: 'dark', language: 'en' }, 60000); // 1 minute TTL
const config = get('config:app');
console.log('App config:', config);

// Example 3: Cache miss handling
console.log('\n=== Cache Miss Example ===');
const nonExistent = get('user:999');
console.log('Non-existent key:', nonExistent);

// Example 4: Delete operation
console.log('\n=== Delete Operation ===');
set('temp:data', { temp: 'value' });
console.log('Before delete - exists:', has('temp:data'));
del('temp:data');
console.log('After delete - exists:', has('temp:data'));

// Example 5: Persistent cache (no TTL)
console.log('\n=== Persistent Cache Example ===');
set('app:config', { version: '1.0.0', debug: true }, null); // Persistent - no expiration
set('user:permanent', { name: 'Admin', role: 'admin' }, null); // Another persistent entry

// These will persist until manually deleted
console.log('Persistent config:', get('app:config'));
console.log('Persistent user:', get('user:permanent'));

// Example 6: Cache statistics
console.log('\n=== Cache Statistics ===');
const cacheStats = stats();
console.log('Cache stats:', cacheStats);

// Example 7: Cleanup expired entries
console.log('\n=== Cleanup Example ===');
// Set an entry that will expire immediately
set('expired:key', { data: 'expired' }, -1000);
console.log('Expired entries before cleanup:', stats().expired);
const cleaned = cleanup();
console.log(`Cleaned up ${cleaned} expired entries`);
console.log('Expired entries after cleanup:', stats().expired);

// Example 8: Clear all cache
console.log('\n=== Clear All Cache ===');
console.log('Entries before clear:', stats().total);
clear();
console.log('Entries after clear:', stats().total);

// Example 9: Error handling with invalid JSON (edge case)
console.log('\n=== Error Handling Example ===');
// This would normally be handled internally, but demonstrates robustness
set('invalid:json', 'not-valid-json');
const result = get('invalid:json');
console.log('Invalid JSON handling:', result);