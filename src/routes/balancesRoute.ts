import { Hono } from 'hono';
import { postgresDb } from '../db/client';
import { exchanges } from '../db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '../utils/logger';

import { GateHandler } from '../handlers/gate/gateHandler';
import { OkxHandler } from '../handlers/okx/okxHandler';
import { BitgetHandler } from '../handlers/bitget/bitgetHandler';
import { BitmartHandler } from '../handlers/bitmart/bitmartHandler';
import { MexcHandler } from '../handlers/mexc/mexcHandler';
import { TokocryptoHandler } from '../handlers/tokocrypto/tokocryptoHandler';
import { HyperliquidHandler } from '../handlers/hyperliquid/hyperliquidHandler';

import { GateServices } from '../services/gateServices';
import { OkxServices } from '../services/okxServices';
import { BitgetServices } from '../services/bitgetServices';
import { BitmartServices } from '../services/bitmartServices';
import { MexcServices } from '../services/mexcServices';
import { TokocryptoServices } from '../services/tokocryptoServices';
import { HyperliquidServices } from '../services/hyperliquidServices';

const log = createLogger({ process: 'balances' });

const balancesRouter = new Hono();

balancesRouter.get('/', async (c) => {
  const exchangeIdParam = c.req.query('exchange_id');

  if (!exchangeIdParam || !/^\d+$/.test(exchangeIdParam) || parseInt(exchangeIdParam, 10) <= 0) {
    return c.json({ error: 'exchange_id must be a positive integer' }, 400);
  }

  const exchange_id = parseInt(exchangeIdParam, 10);

  const exchange = await postgresDb.query.exchanges.findFirst({
    where: eq(exchanges.id, exchange_id),
  });

  if (!exchange) {
    return c.json({ error: 'Exchange not found' }, 404);
  }

  const exchange_title = exchange.exchange_title;

  try {
    let data: any;

    if (exchange_title === 'gate') {
      const creds = await GateHandler.unwrapCredentials(exchange_id);
      GateServices.initialize(creds.api_key, creds.api_secret);
      try {
        data = await GateServices.getBalances();
      } finally {
        GateServices.clearCredentials();
      }

    } else if (exchange_title === 'okx') {
      const creds = await OkxHandler.unwrapCredentials(exchange_id);
      OkxServices.initialize(creds.api_key, creds.api_secret, creds.api_passphrase);
      try {
        data = await OkxServices.getBalances();
      } finally {
        OkxServices.clearCredentials();
      }

    } else if (exchange_title === 'bitget') {
      const creds = await BitgetHandler.unwrapCredentials(exchange_id);
      BitgetServices.initialize(creds.api_key, creds.api_secret, creds.api_passphrase);
      try {
        data = await BitgetServices.getBalances();
      } finally {
        BitgetServices.clearCredentials();
      }

    } else if (exchange_title === 'bitmart') {
      const creds = await BitmartHandler.unwrapCredentials(exchange_id);
      // api_passphrase holds the BitMart memo/uid
      BitmartServices.initialize(creds.api_key, creds.api_secret, creds.api_passphrase);
      try {
        data = await BitmartServices.getBalances();
      } finally {
        BitmartServices.clearCredentials();
      }

    } else if (exchange_title === 'mexc') {
      const creds = await MexcHandler.unwrapCredentials(exchange_id);
      MexcServices.initialize(creds.api_key, creds.api_secret);
      try {
        data = await MexcServices.getBalances();
      } finally {
        MexcServices.clearCredentials();
      }

    } else if (exchange_title === 'tokocrypto') {
      const creds = await TokocryptoHandler.unwrapCredentials(exchange_id);
      // DB stores "futures" but TokocryptoServices.initialize expects 'spot' | 'future'
      const marketType: 'spot' | 'future' =
        exchange.market_type === 'spot' ? 'spot' : 'future';
      TokocryptoServices.initialize(creds.api_key, creds.api_secret, marketType);
      try {
        data = await TokocryptoServices.getBalances();
      } finally {
        TokocryptoServices.clearCredentials();
      }

    } else if (exchange_title === 'hyperliquid') {
      const creds = await HyperliquidHandler.unwrapCredentials(exchange_id);
      // No initialize() needed for the public /info endpoint
      try {
        data = await HyperliquidServices.getBalances(creds.wallet_address);
      } finally {
        HyperliquidServices.clearCredentials();
      }

    } else {
      return c.json({ error: `Unsupported exchange: ${exchange_title}` }, 400);
    }

    if (data && data.status === 'error') {
      log.error({ exchange_id, exchange_title, data }, 'Exchange returned error');
      return c.json({ exchange_id, exchange_title, data }, { status: data.statusCode ?? 500 });
    }

    return c.json({ exchange_id, exchange_title, data });

  } catch (err: any) {
    log.error({ err, exchange_id, exchange_title }, 'Unexpected error fetching balances');
    return c.json(
      { error: err.message || 'Internal server error', exchange_id, exchange_title },
      500,
    );
  }
});

export default balancesRouter;
