import { Hono } from 'hono';
import { testConnection } from './src/db/client';
import redis from './src/db/redis';

// Test data for trading plans
const testTradingPlan = {
  owner_user_id: 1,
  name: "Test Trading Plan",
  description: "A test trading plan for automated testing",
  strategy: "Momentum trading with risk management",
  parameters: {
    entry_conditions: ["RSI < 30", "MACD crossover"],
    exit_conditions: ["Take profit at 5%", "Stop loss at 2%"],
    risk_per_trade: 2,
    max_position_size: 1000,
    stop_loss_percentage: 2,
    take_profit_percentage: 5
  },
  visibility: "PUBLIC",
  total_followers: 0,
  pnl_30d: "15.50",
  max_dd: "5.20",
  sharpe: "1.80",
  is_active: true
};

const testTradingPlanPair = {
  trading_plan_id: 1,
  base_asset: "BTC",
  quote_asset: "USDT",
  symbol: "BTC_USDT"
};

async function runTests() {
  console.log('🚀 Starting Trading Plan API Tests...\n');

  try {
    // Test database connection
    console.log('📊 Testing database connection...');
    const dbOk = await testConnection();
    if (!dbOk) {
      console.error('❌ Database connection failed');
      return;
    }
    console.log('✅ Database connection successful');

    // Test Redis connection
    console.log('📊 Testing Redis connection...');
    try {
      await redis.ping();
      console.log('✅ Redis connection successful');
    } catch (error) {
      console.error('❌ Redis connection failed:', error);
    }

    console.log('\n📋 Available Endpoints:');
    console.log('=======================');
    console.log('POST   /trading-plans/');
    console.log('GET    /trading-plans/');
    console.log('GET    /trading-plans/:id');
    console.log('PATCH  /trading-plans/:id');
    console.log('DELETE /trading-plans/:id');
    console.log('GET    /trading-plans/stats');
    console.log('GET    /trading-plans/:id/with-pairs');
    console.log('');
    console.log('POST   /trading-plans/pairs');
    console.log('GET    /trading-plans/pairs');
    console.log('GET    /trading-plans/pairs/:id');
    console.log('PATCH  /trading-plans/pairs/:id');
    console.log('DELETE /trading-plans/pairs/:id');
    console.log('GET    /trading-plans/:trading_plan_id/pairs');
    console.log('');
    console.log('POST   /trading-plans/batch');
    console.log('POST   /trading-plans/pairs/batch');
    console.log('');
    console.log('PATCH  /trading-plans/:id/status');
    console.log('PATCH  /trading-plans/:id/visibility');
    console.log('PATCH  /trading-plans/:id/metrics');
    console.log('PATCH  /trading-plans/:id/followers');
    console.log('');
    console.log('GET    /trading-plans/health');

    console.log('\n📝 Example Requests:');
    console.log('===================');
    
    console.log('\n1. Create Trading Plan:');
    console.log('POST /trading-plans/');
    console.log('Body:', JSON.stringify(testTradingPlan, null, 2));

    console.log('\n2. Query Trading Plans:');
    console.log('GET /trading-plans/?visibility=PUBLIC&is_active=true&limit=10&offset=0');

    console.log('\n3. Create Trading Plan Pair:');
    console.log('POST /trading-plans/pairs');
    console.log('Body:', JSON.stringify(testTradingPlanPair, null, 2));

    console.log('\n4. Get Trading Plan with Pairs:');
    console.log('GET /trading-plans/1/with-pairs');

    console.log('\n5. Update Trading Plan Metrics:');
    console.log('PATCH /trading-plans/1/metrics');
    console.log('Body:', JSON.stringify({
      pnl_30d: "20.75",
      max_dd: "4.80",
      sharpe: "2.10"
    }, null, 2));

    console.log('\n6. Get Trading Plan Statistics:');
    console.log('GET /trading-plans/stats');

    console.log('\n📚 Validation Rules:');
    console.log('===================');
    console.log('- owner_user_id: positive integer, must exist in users table');
    console.log('- name: string, min 1, max 255 characters');
    console.log('- description: string, min 1 character');
    console.log('- strategy: string, min 1 character');
    console.log('- parameters: JSON object with trading parameters');
    console.log('- visibility: PRIVATE, UNLISTED, or PUBLIC');
    console.log('- total_followers: non-negative integer');
    console.log('- pnl_30d, max_dd, sharpe: decimal strings with precision 10, scale 2');
    console.log('- is_active: boolean');
    console.log('');
    console.log('For Trading Plan Pairs:');
    console.log('- trading_plan_id: positive integer, must exist in trading_plans table');
    console.log('- base_asset, quote_asset: string, min 1, max 50 characters');
    console.log('- symbol: string, min 1, max 100 characters');
    console.log('- Symbol must be unique within a trading plan');

    console.log('\n🔧 Error Handling:');
    console.log('=================');
    console.log('- 400: Validation errors (ZodError)');
    console.log('- 404: Resource not found');
    console.log('- 409: Conflict (duplicate entries)');
    console.log('- 500: Internal server error');

    console.log('\n✅ Trading Plan API is ready for testing!');
    console.log('\nTo test the API:');
    console.log('1. Start the server: bun run dev');
    console.log('2. Use tools like curl, Postman, or Thunder Client');
    console.log('3. Test each endpoint with the example data above');
    console.log('4. Check the database for created records');

  } catch (error) {
    console.error('❌ Test setup failed:', error);
  }
}

// Run tests if this file is executed directly
if (import.meta.main) {
  runTests().catch(console.error);
}

export { runTests };