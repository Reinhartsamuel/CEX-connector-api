import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
// Create database connection
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
}
// Create postgres client with connection pooling
export const client = postgres(connectionString, {
    max: 10, // Maximum number of connections in pool
    idle_timeout: 30, // Close idle connections after 30 seconds
    connect_timeout: 10, // Connection timeout in seconds
});
// Create drizzle client with schema
export const postgresDb = drizzle(client, { schema });
// Test connection on startup
export async function testConnection() {
    try {
        await client `SELECT 1`;
        console.log('✅ PostgreSQL connected successfully');
        return true;
    }
    catch (error) {
        console.error('❌ PostgreSQL connection failed:', error);
        return false;
    }
}
// Graceful shutdown
export async function closeConnection() {
    console.log('🔌 Closing PostgreSQL connections...');
    await client.end();
}
// Export schema for use in queries
export { schema };
