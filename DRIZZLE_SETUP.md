# Drizzle ORM Setup for Byscript Connector API

## Database Schema

The schema has been converted from the original SQL file and includes:

### Tables
- `users` - Platform users
- `exchanges` - Exchange connections with API credentials
- `webhooks` - Incoming webhook triggers
- `trades` - Trading positions and orders
- `webhook_responses` - Exchange API responses
- `order_updates` - Real-time order updates

### Key Features
- **Relations**: All tables have proper foreign key relationships
- **Indexes**: Performance indexes for common queries
- **Types**: TypeScript types automatically inferred from schema
- **Cascading deletes**: Proper cascade behavior for related records

## Single Migration Approach

Instead of using Drizzle's generated migrations (which have limitations with PostgreSQL-specific features), we've created a comprehensive single migration file that includes everything:

### Complete Migration File:
- `0000_complete_schema.sql` - Contains:
  - All 6 tables with proper columns and data types
  - Foreign key relationships with cascade behavior
  - Performance indexes for all common queries
  - Automatic `updated_at` timestamp triggers
  - PostgreSQL functions for timestamp updates
  - Table comments for documentation

### Applying the Migration:
```bash
# Apply the complete schema in one command
psql -d your_database_name -f src/db/migrations/0000_complete_schema.sql
```

## Usage Examples

### Import and Use Database Client

```typescript
import { db } from './src/db/client';
import { users, exchanges, trades } from './src/db/schema';
import { eq } from 'drizzle-orm';

// Query all active users
const activeUsers = await db
  .select()
  .from(users)
  .where(eq(users.isActive, true));

// Insert a new user
const newUser = await db
  .insert(users)
  .values({
    username: 'john_doe',
    email: 'john@example.com',
    passwordHash: 'hashed_password',
    name: 'John Doe',
  })
  .returning();

// Query with relations
const userWithExchanges = await db.query.users.findMany({
  with: {
    exchanges: true,
    trades: true,
  },
});
```

### Using TypeScript Types

```typescript
import type { User, NewUser, Trade } from './src/db/schema';

function createUser(userData: NewUser): Promise<User> {
  return db.insert(users).values(userData).returning();
}

function updateTradeStatus(tradeId: number, status: Trade['status']) {
  return db
    .update(trades)
    .set({ status })
    .where(eq(trades.id, tradeId));
}
```

## Development Workflow

### 1. Making Schema Changes

Since we're using a manual migration approach:

1. Edit `src/db/schema.ts` (for TypeScript types and Drizzle queries)
2. Update `src/db/migrations/0000_complete_schema.sql` with any schema changes
3. Apply the updated migration to your database

### 2. Development (Quick Iteration)

For rapid development, you can use Drizzle push mode for basic changes:

```bash
bun run db:push
```

**Note**: This won't include PostgreSQL-specific features like triggers, functions, or custom indexes.

### 3. Production

Use the comprehensive migration file:

```bash
psql -d your_database_name -f src/db/migrations/0000_complete_schema.sql
```

## Drizzle Studio

Drizzle Studio provides a web-based interface to view and manage your database:

```bash
bun run db:studio
```

This opens a browser window where you can:
- Browse tables and data
- Run queries
- View relationships
- Export data

```env
## Migration from Original SQL

The original SQL schema has been fully converted with:

- ✅ All 6 tables and columns preserved exactly
- ✅ Foreign key relationships with proper cascade behavior
- ✅ All performance indexes included
- ✅ Unique constraints enforced
- ✅ Default values and constraints maintained
- ✅ JSONB columns for flexible data storage
- ✅ Timestamp with timezone support
- ✅ PostgreSQL triggers and functions for automatic timestamps
- ✅ Table comments for documentation
```

### 2. Drizzle Configuration

The `drizzle.config.ts` file is configured to:
- Use PostgreSQL dialect
- Read schema from `./src/db/schema.ts`
- Output migrations to `./src/db/migrations`

## Available Scripts

The following scripts are available in `package.json`:

```bash
# Generate migrations based on schema changes
bun run db:generate

# Push schema changes directly to database (development)
bun run db:push

# Open Drizzle Studio for database management
bun run db:studio

# Run migrations
bun run db:migrate
```

This document explains how to set up and use Drizzle ORM with the Byscript Connector API.

## Installation

Drizzle ORM and its dependencies have already been installed:

```bash
# Dependencies already installed:
bun add drizzle-orm postgres
bun add -d drizzle-kit @types/pg
```

## Project Structure

```
byscript-connector-api/
├── src/
│   └── db/
│       ├── schema.ts          # Drizzle schema definitions
│       ├── client.ts          # Database client configuration
│       └── migrations/        # Generated migrations (auto-created)
├── drizzle.config.ts          # Drizzle configuration
└── package.json               # Contains Drizzle scripts
```

## Configuration

### 1. Environment Variables

Make sure you have a `DATABASE_URL` environment variable set in your `.env` file:

```env
DATABASE_URL=postgresql://username:password@localhost:5432/byscript_connector
```

### 2. Drizzle Configuration

The `drizzle.config.ts` file is configured to:
- Use PostgreSQL dialect
- Read schema from `./src/db/schema.ts`
- Output migrations to `./src/db/migrations`

## Available Scripts

The following scripts are available in `package.json`:

```bash
# Generate migrations based on schema changes
bun run db:generate

# Push schema changes directly to database (development)
bun run db:push

# Open Drizzle Studio for database management
bun run db:studio

# Run migrations
bun run db:migrate
```

## Database Schema

The schema has been converted from the original SQL file and includes:

### Tables
- `users` - Platform users
- `exchanges` - Exchange connections with API credentials
- `webhooks` - Incoming webhook triggers
- `trades` - Trading positions and orders
- `webhook_responses` - Exchange API responses
- `order_updates` - Real-time order updates

### Key Features
- **Relations**: All tables have proper foreign key relationships
- **Indexes**: Performance indexes for common queries
- **Types**: TypeScript types automatically inferred from schema
- **Cascading deletes**: Proper cascade behavior for related records

## Usage Examples

### Import and Use Database Client

```typescript
import { db } from './src/db/client';
import { users, exchanges, trades } from './src/db/schema';

// Query all active users
const activeUsers = await db
  .select()
  .from(users)
  .where(eq(users.isActive, true));

// Insert a new user
const newUser = await db
  .insert(users)
  .values({
    username: 'john_doe',
    email: 'john@example.com',
    passwordHash: 'hashed_password',
    firstName: 'John',
    lastName: 'Doe',
  })
  .returning();

// Query with relations
const userWithExchanges = await db.query.users.findMany({
  with: {
    exchanges: true,
    trades: true,
  },
});
```

### Using TypeScript Types

```typescript
import type { User, NewUser, Trade } from './src/db/schema';

function createUser(userData: NewUser): Promise<User> {
  return db.insert(users).values(userData).returning();
}

function updateTradeStatus(tradeId: number, status: Trade['status']) {
  return db
    .update(trades)
    .set({ status })
    .where(eq(trades.id, tradeId));
}
```

## Development Workflow

### 1. Making Schema Changes

1. Edit `src/db/schema.ts`
2. Generate migration: `bun run db:generate`
3. Apply migration: `bun run db:migrate`

### 2. Development (Quick Iteration)

For rapid development, use push mode:

```bash
bun run db:push
```

This directly applies schema changes without generating migration files.

### 3. Production

Always use migrations in production:

```bash
bun run db:generate
bun run db:migrate
```

## Drizzle Studio

Drizzle Studio provides a web-based interface to view and manage your database:

```bash
bun run db:studio
```

This opens a browser window where you can:
- Browse tables and data
- Run queries
- View relationships
- Export data

## Migration from Original SQL

The original SQL schema has been fully converted to Drizzle ORM with:

- ✅ All tables and columns preserved
- ✅ Foreign key relationships maintained
- ✅ Indexes recreated
- ✅ Unique constraints enforced
- ✅ Default values and constraints
- ✅ JSONB columns for flexible data storage
- ✅ Timestamp with timezone support

## Notes

- The schema uses `serial` for auto-incrementing primary keys
- All foreign keys use `bigint` with appropriate references
- JSONB columns are used for flexible payload storage
- Timestamps include timezone information
- Cascade delete behavior is configured for related records

For more information, refer to the [Drizzle ORM documentation](https://orm.drizzle.team).