ALTER TABLE "exchanges" ALTER COLUMN "user_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "order_updates" ALTER COLUMN "user_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "order_updates" ALTER COLUMN "exchange_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "order_updates" ALTER COLUMN "trade_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "user_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "exchange_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "webhook_responses" ALTER COLUMN "webhook_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "webhook_responses" ALTER COLUMN "user_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "webhook_responses" ALTER COLUMN "exchange_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "webhook_responses" ALTER COLUMN "trade_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "webhooks" ALTER COLUMN "user_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "webhooks" ALTER COLUMN "exchange_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "exchanges" ADD COLUMN "exchange_external_id" text;--> statement-breakpoint
ALTER TABLE "exchanges" ADD COLUMN "exchange_external_name" text;