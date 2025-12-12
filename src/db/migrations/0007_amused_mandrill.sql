ALTER TABLE "exchanges" ALTER COLUMN "exchange_title" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "exchanges" ALTER COLUMN "api_key" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "exchanges" ALTER COLUMN "api_secret" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "order_updates" ALTER COLUMN "exchange_trade_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "order_updates" ALTER COLUMN "update_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "order_updates" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "trade_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "order_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "open_order_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "open_fill_price" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "close_order_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "close_reason" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "contract" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "position_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "market_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "leverage_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "position_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "take_profit_price_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "stop_loss_price_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "tpsl_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "username" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "name" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "firebase_uid" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "webhooks" ALTER COLUMN "action" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "webhooks" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "webhooks" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "exchanges" ADD COLUMN "market_code" text;--> statement-breakpoint
ALTER TABLE "exchanges" ADD COLUMN "market_type" text;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "type" text DEFAULT 'subscription';