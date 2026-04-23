import { beforeEach, expect, mock, test } from 'bun:test';

const state = {
  selectCall: 0,
  keyRow: {
    id: 11,
    trading_plan_id: 77,
    secret_hash: '',
    rate_limit: 100,
    is_active: true,
  } as any,
  followers: [] as any[],
  exchangesById: new Map<number, any>(),
  webhookInserts: [] as any[],
  executorCalls: [] as any[],
  rateIncrCount: 0,
  exchangeLookupIndex: 0,
};

function makeJsonContext(body: Record<string, unknown>) {
  let status = 200;
  let payload: any = null;

  const c = {
    req: {
      json: async () => body,
    },
    json: (data: any, httpStatus?: number) => {
      payload = data;
      status = httpStatus ?? 200;
      return { status, body: payload };
    },
  } as any;

  return {
    c,
    getResponse: () => ({ status, body: payload }),
  };
}

mock.module('../../db/redis', () => ({
  default: {
    incr: async () => {
      state.rateIncrCount += 1;
      return state.rateIncrCount;
    },
    expire: async () => 1,
  },
}));

mock.module('../../utils/logger', () => ({
  createLogger: () => ({
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  }),
}));

mock.module('../../utils/metrics', () => ({
  tradesOpenedTotal: { inc: () => {} },
  signalLatency: { observe: () => {} },
  exchangeErrorsTotal: { inc: () => {} },
}));

mock.module('../../handlers/gate/gateHandler', () => ({
  GateHandler: {
    unwrapCredentials: async () => ({
      api_key: 'gate-key',
      api_secret: 'gate-secret',
      exchange_user_id: 'gate-user',
    }),
  },
}));

mock.module('../../handlers/okx/okxHandler', () => ({
  OkxHandler: {
    unwrapCredentials: async () => ({
      api_key: 'okx-key',
      api_secret: 'okx-secret',
      api_passphrase: 'okx-pass',
      exchange_user_id: 'okx-user',
    }),
  },
}));

mock.module('../../handlers/hyperliquid/hyperliquidHandler', () => ({
  HyperliquidHandler: {
    unwrapCredentials: async () => ({
      wallet_address: '0xabc',
      agent_private_key: 'hl-secret',
      exchange_user_id: '0xabc',
    }),
  },
}));

mock.module('../../handlers/tokocrypto/tokocryptoHandler', () => ({
  TokocryptoHandler: {
    unwrapCredentials: async () => ({
      api_key: 'toko-key',
      api_secret: 'toko-secret',
      exchange_user_id: 'toko-user',
    }),
  },
}));

mock.module('../../executors/registry', () => ({
  getExecutor: (exchangeTitle: string) => ({
    execute: async (ctx: any) => {
      state.executorCalls.push({ exchangeTitle, autotraderId: ctx.autotrader.id });
      return { success: true, exchange_order_id: `ord-${ctx.autotrader.id}`, raw: { ok: true } };
    },
  }),
}));

mock.module('../../db/client', () => ({
  postgresDb: {
    select: () => ({
      from: () => ({
        where: () => {
          state.selectCall += 1;
          if (state.selectCall === 1) {
            return {
              limit: async () => [state.keyRow],
            };
          }
          return state.followers;
        },
      }),
    }),

    query: {
      exchanges: {
        findFirst: async () => {
          const follower = state.followers[state.exchangeLookupIndex] ?? null;
          state.exchangeLookupIndex += 1;
          if (!follower) return null;
          return state.exchangesById.get(Number(follower.exchange_id)) ?? null;
        },
      },
    },

    insert: (table: any) => ({
      values: (row: any) => {
        if (row?.type === 'subscription' || row?.type === 'personal') {
          state.webhookInserts.push(row);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{ id: state.webhookInserts.length }],
            }),
          };
        }
        return Promise.resolve();
      },
    }),

    update: () => ({
      set: () => ({ where: async () => {} }),
    }),
  },
}));

beforeEach(() => {
  state.selectCall = 0;
  state.rateIncrCount = 0;
  state.exchangeLookupIndex = 0;
  state.webhookInserts = [];
  state.executorCalls = [];

  const crypto = require('node:crypto') as typeof import('node:crypto');
  state.keyRow = {
    id: 11,
    trading_plan_id: 77,
    secret_hash: crypto.createHash('sha256').update('top-secret').digest('hex'),
    rate_limit: 100,
    is_active: true,
  };

  state.followers = [
    { id: 1, user_id: 1, exchange_id: 101, trading_plan_id: 77, trading_plan_pair_id: null, symbol: 'BTC_USDT', pair: 'BTC/USDT', status: 'active' },
    { id: 2, user_id: 2, exchange_id: 102, trading_plan_id: 77, trading_plan_pair_id: null, symbol: 'BTC-USDT-SWAP', pair: 'BTC/USDT', status: 'active' },
    { id: 3, user_id: 3, exchange_id: 103, trading_plan_id: 77, trading_plan_pair_id: null, symbol: 'BTC/USDT', pair: 'BTC/USDT', status: 'active' },
  ];

  state.exchangesById = new Map([
    [101, { id: 101, exchange_title: 'gate' }],
    [102, { id: 102, exchange_title: 'okx' }],
    [103, { id: 103, exchange_title: 'tokocrypto' }],
  ]);
});

test('plan signal fans out to all active followers across exchanges', async () => {
  const { SignalHandler } = await import('../signalHandler');

  const { c, getResponse } = makeJsonContext({
    key_id: 11,
    secret: 'top-secret',
    action: 'BUY',
    order_type: 'market',
    market_price: 50000,
    event_id: 'evt-123',
  });

  await SignalHandler.handlePublicSignal(c);
  await Bun.sleep(10);

  const res = getResponse();
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.trading_plan_id).toBe(77);
  expect(res.body.followers_count).toBe(3);

  expect(state.executorCalls).toHaveLength(3);
  expect(state.executorCalls.map((x) => x.exchangeTitle).sort()).toEqual(['gate', 'okx', 'tokocrypto']);
  expect(state.webhookInserts).toHaveLength(3);
  expect(state.webhookInserts.every((w) => w.type === 'subscription')).toBe(true);
  expect(state.webhookInserts.every((w) => String(w.dedupe_key).includes('evt-123'))).toBe(true);
});

test('plan signal pair filtering triggers only matching followers', async () => {
  const { SignalHandler } = await import('../signalHandler');

  state.followers = [
    { id: 1, user_id: 1, exchange_id: 101, trading_plan_id: 77, trading_plan_pair_id: 901, symbol: 'BTC_USDT', pair: 'BTC/USDT', status: 'active' },
    { id: 2, user_id: 2, exchange_id: 102, trading_plan_id: 77, trading_plan_pair_id: 902, symbol: 'ETH-USDT-SWAP', pair: 'ETH/USDT', status: 'active' },
  ];

  const { c, getResponse } = makeJsonContext({
    key_id: 11,
    secret: 'top-secret',
    action: 'SELL',
    order_type: 'market',
    market_price: 3000,
    pair_id: 901,
  });

  await SignalHandler.handlePublicSignal(c);
  await Bun.sleep(10);

  const res = getResponse();
  expect(res.status).toBe(200);
  expect(res.body.followers_count).toBe(1);
  expect(state.executorCalls).toHaveLength(1);
  expect(state.executorCalls[0].autotraderId).toBe(1);
});
