/* eslint-disable @typescript-eslint/no-explicit-any */
import { Context } from "hono";
import { HyperliquidServices } from "../../services/hyperliquidServices";
import { postgresDb } from "../../db/client";
import { exchanges, trades } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import * as JSONbig from "json-bigint";
import * as z from "zod";
import {
  decrypt,
  generateAndEncryptCredentials,
  kmsClient,
} from "../../utils/cryptography/kmsUtils";
import { DecryptCommand } from "@aws-sdk/client-kms";
import { gatePlaceFuturesOrdersSchema } from "../../schemas/gateSchemas";
import { redis } from "../../db/redis";

export const HyperliquidHandler = {
  /**
   * Unwraps credentials from the DB and decrypts them via KMS.
   * For Hyperliquid:
   * api_key = Public Wallet Address (lowercase)
   * api_secret = Agent Private Key (Required for signing)
   */
  unwrapCredentials: async function (exchangeId: number) {
    const exchange = await postgresDb.query.exchanges.findFirst({
      where: eq(exchanges.id, exchangeId),
    });
    if (!exchange) throw new Error("Exchange record not found");

    const dekResp = await kmsClient.send(
      new DecryptCommand({
        CiphertextBlob: exchange.enc_dek!,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      }),
    );
    if (!dekResp.Plaintext) throw new Error("KMS DEK decryption failed");

    const plaintextDEK = Buffer.from(dekResp.Plaintext);

    const decryptedWalletAddress = decrypt(
      JSON.parse(exchange.api_key_encrypted),
      plaintextDEK,
    ).toLowerCase(); // Ensure lowercase for Hyperliquid compatibility

    const decryptedAgentPrivateKey = decrypt(
      JSON.parse(exchange.api_secret_encrypted),
      plaintextDEK,
    );

    // Zero out sensitive DEK buffer
    plaintextDEK.fill(0);

    return {
      wallet_address: decryptedWalletAddress,
      agent_private_key: decryptedAgentPrivateKey,
      user_id: exchange.user_id,
      exchange_user_id: exchange.exchange_user_id,
    };
  },

  /**
   * Registers a new Hyperliquid account (Agent Wallet).
   * UPDATED: Removes validation that forced Agent Key to match Master Address.
   */
  registerUser: async function (c: Context) {
    try {
      const body = await c.req.json();
      let { master_wallet_address, private_key, user_id } = body;

      // Hyperliquid standard: always lowercase addresses
      master_wallet_address = master_wallet_address.toLowerCase();

      // 1. Initialize Service to validate the key pair locally
      // This ensures the private_key is a valid format (e.g. hex string)
      HyperliquidServices.initialize(private_key);

      // 2. Validation: Check if Private Key was valid
      // FIX: We DO NOT compare this address to master_wallet_address
      // because the Agent Address is SUPPOSED to be different.
      if (!HyperliquidServices.account) {
        HyperliquidServices.clearCredentials();
        return c.json({ message: "Invalid Private Key format." }, 400);
      }

      // Optional: Log the link for debugging
      console.log(
        `Linking Agent [${HyperliquidServices.account.address}] to Master [${master_wallet_address}]`,
      );

      // 3. Check Account Existence (clearinghouseState) via /info endpoint
      // We check the MASTER wallet to ensure the user has funds/account on L1
      const reqAccount = await HyperliquidServices.whitelistedRequest({
        method: "POST",
        requestPath: "/info",
        payloadString: JSON.stringify({
          type: "clearinghouseState",
          user: master_wallet_address,
        }),
      });

      // Clear credentials from service memory after check
      HyperliquidServices.clearCredentials();

      if (reqAccount.status === "error") {
        return c.json(
          {
            message: "Could not verify Master Account on Hyperliquid",
            ...reqAccount,
          },
          400,
        );
      }

      // 4. Check DB for duplicate registration
      const existing = await postgresDb.query.exchanges.findFirst({
        where: and(
          eq(exchanges.exchange_title, "hyperliquid"),
          eq(exchanges.user_id, user_id),
        ),
      });

      if (existing?.id) {
        return c.json(
          {
            message: "ERROR!",
            error: `Exchange already registered for hyperliquid user_id ${user_id}`,
          },
          400,
        );
      }

      // 5. Encrypt Credentials via KMS
      // Mapping:
      // api_key    = Master Wallet (The Identity)
      // api_secret = Agent Private Key (The Signer)
      const {
        encryptedDEK,
        apiKey: encryptedWallet,
        apiSecret: encryptedPrivateKey,
      } = await generateAndEncryptCredentials(
        master_wallet_address,
        private_key,
        "N/A",
      );

      // Clear the cleartext private key from memory
      private_key = "";

      // 6. Insert record into Postgres
      const exchangeRecord = await postgresDb
        .insert(exchanges)
        .values({
          user_id,
          exchange_title: "hyperliquid",
          exchange_user_id: master_wallet_address,
          market_type: "futures",
          api_key_encrypted: JSON.stringify(encryptedWallet),
          api_secret_encrypted: JSON.stringify(encryptedPrivateKey),
          api_passphrase_encrypted: JSON.stringify({ ciphertext: "N/A" }),
          enc_dek: encryptedDEK,
        })
        .returning();

      return c.json({
        message: "ok",
        exchange_id: exchangeRecord[0].id,
        account_status: "verified",
      });
    } catch (e: any) {
      console.error(e, "ERROR REGISTER USER hyperliquid");
      return c.json(
        { message: "Internal Server Error", error: e.message },
        500,
      );
    }
  },

  /**
   * Playground for testing raw /info and /exchange actions.
   */
  playground: async function (c: Context) {
    try {
      const private_key = c.req.header("api-secret");
      if (!private_key)
        throw new Error("Missing api-secret (Agent Private Key) in headers");

      HyperliquidServices.initialize(private_key);

      const body = (await c.req.json()) as {
        method: string;
        requestPath: string; // "/info" or "/exchange"
        payload: any;
      };

      const res = await HyperliquidServices.whitelistedRequest({
        method: body.method || "POST",
        requestPath: body.requestPath,
        payloadString: body.payload ? JSON.stringify(body.payload) : undefined,
      });

      HyperliquidServices.clearCredentials();
      return c.json(res);
    } catch (e: any) {
      console.error(e, "ERROR 500 PLAYGROUND hyperliquid");
      return c.json({ message: "ERROR", error: e.message }, 500);
    }
  },
  /**
   * PLACE ORDER (Open Position)
   * Handles Leverage setup and Order placement
   */
  order: async function (c: Context) {
    try {
      const body = (await c.req.json()) as z.infer<
        typeof gatePlaceFuturesOrdersSchema
      >;
      const { agent_private_key, wallet_address, user_id } =
        await HyperliquidHandler.unwrapCredentials(body.exchange_id);

      HyperliquidServices.initialize(agent_private_key);

      let allReturn: {
        message: any;
        data: any;
      } = {
        message: null,
        data: null,
      };

      // 1. Get the specific decimals for this coin (e.g., DOGE)
      const assetMeta = await HyperliquidServices.getAssetMetadata(
        body.contract,
      );
      console.log(assetMeta, "assetMeta");

      let price = String(body.price);
      const isBuy = body.position_type === "long";

      // 2. Handle Market Order Slippage with Dynamic Precision
      if (body.market_type === "market") {
        const basePrice = body.price;
        const slippageMultiplier = isBuy ? 1.1 : 0.9;
        const rawSlippagePrice = basePrice * slippageMultiplier;

        // Use our new helper
        price = HyperliquidServices.formatHyperliquidPrice(
          rawSlippagePrice,
          assetMeta.szDecimals,
        );
      } else {
        // Even for Limit orders, it's good to ensure the user's price is valid
        price = HyperliquidServices.formatHyperliquidPrice(
          body.price,
          assetMeta.szDecimals,
        );
      }
      const resLeverage = await HyperliquidServices.updateLeverage(
        body.contract,
        body.leverage || 1,
        body.leverage_type === "CROSS", // boolean isCross
      );
      console.log(resLeverage, "resLeverage");

      // 4. Calculate and Format Size
      // body.size is USD amount to trade
      // Step A: Convert USD/Contract Margin to Base Asset Amount (Coins)
      const rawCoinSize = (body.size * body.leverage) / body.price;

      // Step B: Round it strictly to valid decimals using helper
      const formattedSize = HyperliquidServices.formatHyperliquidSize(
        rawCoinSize,
        assetMeta.szDecimals,
      );

      // 5. Place the Order
      const resPlaceOrder = await HyperliquidServices.placeOrder({
        contract: body.contract,
        position_type: body.position_type,
        market_type: body.market_type,
        size: parseFloat(formattedSize), // Pass the clean, rounded number
        price: String(parseFloat(price)),
        reduce_only: body.reduce_only,
      });
      console.log(JSON.stringify(resPlaceOrder, null, 2), "resPlaceOrder");

      // Clear credentials from service
      HyperliquidServices.clearCredentials();

      // 6. Parse Hyperliquid Response
      // Hyperliquid returns an array of statuses in response.data.statuses
      const orderStatusData = resPlaceOrder?.response?.data?.statuses?.[0];

      let tradeStatus = "error";
      let orderId = "";

      // Type guard for orderStatusData
      if (orderStatusData && typeof orderStatusData === "object") {
        if ("resting" in orderStatusData && orderStatusData.resting) {
          tradeStatus = "waiting_position"; // Limit order is on the book
          orderId = String(orderStatusData.resting.oid);
        } else if ("filled" in orderStatusData && orderStatusData.filled) {
          tradeStatus = "waiting_targets"; // Market/Limit order filled immediately
          orderId = String(orderStatusData.filled.oid);
        } else if ("error" in orderStatusData && orderStatusData.error) {
          tradeStatus = "error";
          allReturn.message = `Hyperliquid Error: ${orderStatusData.error}`;
        }
      }

      // 6. Record Trade in Database
      const addData: any = {
        user_id: user_id,
        exchange_id: body.exchange_id,
        trade_id: orderId,
        order_id: orderId,
        open_order_id: orderId,
        autotrader_id: body.autotrader_id,
        contract: body.contract,
        position_type: body.position_type,
        market_type: body.market_type,
        size: body.size,
        leverage: body.leverage || 1,
        leverage_type: body.leverage_type || "CROSS",
        status: tradeStatus,
        price: body.price,
        reduce_only: body.reduce_only || false,
        metadata: JSON.parse(JSONbig.stringify(resPlaceOrder)),
        take_profit_enabled: body.take_profit?.enabled || false,
        stop_loss_enabled: body.stop_loss?.enabled || false,
      };

      if (
        body.market_type === "market" &&
        (resPlaceOrder?.response?.data?.statuses?.[0] as any)?.filled?.avgPx
      ) {
        addData.open_fill_price =
          (resPlaceOrder?.response?.data?.statuses?.[0] as any)?.filled?.avgPx;
        addData.open_filled_at = Math.floor(Date.now() / 1000);
      }
      console.log(addData, "addData");

      const newTrade = await postgresDb
        .insert(trades)
        .values(addData as any)
        .returning();

      // Store credentials in Redis for worker
      await redis.hset(
        `hyperliquid:creds:${user_id}`,
        "walletAddress", wallet_address,
      );

      // Trigger worker to open WebSocket connection
      await redis.publish(
        "ws-control",
        JSON.stringify({
          op: "open",
          userId: String(user_id),
          userAddress: wallet_address.toLowerCase()
        })
      );

      console.log(`📡 Triggered Hyperliquid worker for user ${user_id} (address: ${wallet_address})`);

      allReturn.data = { resPlaceOrder, newTrade };
      return c.json(allReturn);
    } catch (e: any) {
      console.error(e, "ERROR order hyperliquid");
      return c.json({ message: "ERROR", error: e.message }, 500);
    }
  },

  /**
   * CANCEL ORDER
   */
  cancelOrder: async function (c: Context) {
    try {
      const body = await c.req.json();
      let { agent_private_key } = await HyperliquidHandler.unwrapCredentials(
        body.exchange_id,
      );

      HyperliquidServices.initialize(agent_private_key);
      agent_private_key = "";

      // Find trades in DB associated with this autotrader and contract
      const foundTrades = await postgresDb.query.trades.findMany({
        where: and(
          eq(trades.autotrader_id, body.autotrader_id),
          eq(trades.contract, body.contract),
          eq(trades.status, "waiting_position"), // Only cancel resting orders
        ),
      });

      console.log(foundTrades,'foundTrades')

      if (foundTrades.length === 0) {
        return c.json({ message: "No active resting trades found to cancel" });
      }

      const results = await Promise.allSettled(
        foundTrades.map(async (trade) => {
          const res = await HyperliquidServices.cancelOrder(
            trade.contract,
            Number(trade.order_id),
          );
          return { ...res, id: trade.id };
        }),
      );

      // Update DB status for successful cancels
      for (const result of results) {
        if (result.status === "fulfilled" && result.value?.status === "ok") {
          await postgresDb
            .update(trades)
            .set({ 
              status: "cancelled",
              cancelled_at : new Date(),
              cancel_reason : "user_request",
           })
            .where(eq(trades.id, result.value.id));
        }
      }

      HyperliquidServices.clearCredentials();
      return c.json(results);
    } catch (e: any) {
      return c.json({ message: "ERROR", error: e.message }, 500);
    }
  },

 /**
   * CLOSE POSITION (Robust Version)
   * 1. Checks Position Size.
   * 2. Fetches CURRENT MARKET PRICE (allMids) to avoid "95% away" errors.
   * 3. Sets a safe aggressive limit (Market +/- 10%) to ensure fill.
   */
closePositionDb: async function (c: Context) {
    try {
      const body = await c.req.json();
      console.log(`[CLOSE] Request for Contract: ${body.contract}, Autotrader: ${body.autotrader_id}`);

      let { agent_private_key, wallet_address } = await HyperliquidHandler.unwrapCredentials(body.exchange_id);

      HyperliquidServices.initialize(agent_private_key);
      agent_private_key = "";

      // 1. Find Trade in DB
      const activeTrade = await postgresDb.query.trades.findFirst({
        where: and(
          eq(trades.autotrader_id, body.autotrader_id),
          eq(trades.contract, body.contract),
          eq(trades.exchange_id, body.exchange_id),
          eq(trades.status, "waiting_targets")
        ),
      });

      if (!activeTrade) {
        console.log("[CLOSE] No active trade found in DB.");
        HyperliquidServices.clearCredentials();
        return c.json({ message: "No active 'waiting_targets' trade found." }, 404);
      }

      // 2. GET POSITION & CURRENT PRICES
      console.log(`[CLOSE] Fetching Position & Market Prices...`);
      
      const [accountState, allMids] = await Promise.all([
         HyperliquidServices.whitelistedRequest({
            method: "POST",
            requestPath: "/info",
            payloadString: JSON.stringify({ type: "clearinghouseState", user: wallet_address }),
         }),
         HyperliquidServices.whitelistedRequest({
            method: "POST",
            requestPath: "/info",
            payloadString: JSON.stringify({ type: "allMids" }),
         })
      ]);

      const cleanSymbol = activeTrade.contract.replace("-USDT", "");
      const position = accountState?.assetPositions?.find(
        (p: any) => p.position.coin === cleanSymbol
      );

      console.log(position, "position");

      // 3. Validate Position Exists
      if (!position || parseFloat(position.position.szi) === 0) {
        console.log("[CLOSE] Position already closed on-chain.");
        await postgresDb
          .update(trades)
          .set({ status: "closed", closed_at: new Date(), close_reason: "already_closed_on_chain" })
          .where(eq(trades.id, activeTrade.id));
        HyperliquidServices.clearCredentials();
        return c.json({ message: "Position already closed. DB Updated." });
      }

      // 4. Validate Current Price
      const currentMarketPrice = parseFloat(allMids?.[cleanSymbol]);
      if (isNaN(currentMarketPrice) || currentMarketPrice <= 0) {
         throw new Error(`Could not fetch valid market price for ${cleanSymbol}`);
      }

      // 5. Prepare Close Parameters
      const currentSizeCoins = parseFloat(position.position.szi);
      const sizeToClose = Math.abs(currentSizeCoins);
      const isLong = currentSizeCoins > 0;
      const closeSide = isLong ? "short" : "long";
      
      // Capture Entry Price for PnL Calculation
      const entryPrice = parseFloat(position.position.entryPx);

      const assetMeta = await HyperliquidServices.getAssetMetadata(activeTrade.contract);
      const formattedSize = HyperliquidServices.formatHyperliquidSize(
        sizeToClose,
        assetMeta.szDecimals
      );

      // 6. Calculate Safe Aggressive Price (Market +/- 10%)
      let targetPrice = 0;
      if (closeSide === "long") {
         targetPrice = currentMarketPrice * 1.10; 
      } else {
         targetPrice = currentMarketPrice * 0.90;
      }

      const formattedPrice = HyperliquidServices.formatHyperliquidPrice(
        targetPrice,
        assetMeta.szDecimals
      );

      if (formattedPrice === "NaN" || !formattedPrice) {
         throw new Error(`Price Calculation Failed. Market: ${currentMarketPrice}, Target: ${targetPrice}`);
      }

      console.log(`[CLOSE] Closing ${formattedSize} ${cleanSymbol}. Entry: ${entryPrice}, Target: ${formattedPrice}`);

      // 7. Execute Close
      const res = await HyperliquidServices.placeOrder({
        contract: activeTrade.contract,
        position_type: closeSide,
        market_type: "market", 
        size: parseFloat(formattedSize),
        price: formattedPrice, 
        reduce_only: true,
      });

      // 8. Check Response & CALCULATE PNL
      const orderStatus = res?.response?.data?.statuses?.[0];
      
      // Error Check
      if (orderStatus && typeof orderStatus === "object" && "error" in orderStatus) {
        console.error("[CLOSE] API Error:", orderStatus.error);
        HyperliquidServices.clearCredentials();
        return c.json({ message: "Failed to close", error: orderStatus.error, res }, 400);
      }

      // --- PNL CALCULATION START ---
      let realizedPnl = "0";
      let exitPrice = 0;

      // Check if order filled immediately (which it should for Market orders)
      if (orderStatus && typeof orderStatus === "object" && "filled" in orderStatus) {
         const fillData = orderStatus.filled;
         exitPrice = parseFloat(fillData.avgPx); // The actual price you sold/bought at
         
         // Formula: (Exit - Entry) * Size * Direction
         // If Long: (Exit - Entry)
         // If Short: (Entry - Exit) -> Equivalent to (Exit - Entry) * -1
         const priceDiff = exitPrice - entryPrice;
         const directionMultiplier = isLong ? 1 : -1;
         
         const rawPnl = priceDiff * sizeToClose * directionMultiplier;
         realizedPnl = rawPnl.toFixed(6); // Store as string for numeric/decimal column
         
         console.log(`[PNL] Entry: ${entryPrice}, Exit: ${exitPrice}, Size: ${sizeToClose}, PnL: ${realizedPnl}`);
      }
      // --- PNL CALCULATION END ---

      // 9. Update DB with PnL
      await postgresDb
        .update(trades)
        .set({ 
           status: "closed", 
           closed_at: new Date(), 
           close_reason: "api_request",
           pnl: realizedPnl, // Save the calculated PnL
           close_fill_price: String(exitPrice) // Optional: Save exit price if your schema has it
        })
        .where(eq(trades.id, activeTrade.id));

      HyperliquidServices.clearCredentials();
      return c.json({
        message: "Position closed successfully",
        closed_size: formattedSize,
        entry_price: entryPrice,
        exit_price: exitPrice,
        realized_pnl: realizedPnl,
        hyperliquid_response: res
      });

    } catch (e: any) {
      console.error(e, "ERROR closePositionDb");
      return c.json({ message: "ERROR", error: e.message }, 500);
    }
  },
};
