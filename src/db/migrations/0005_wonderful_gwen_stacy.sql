ALTER TABLE "trades" ADD COLUMN "order_id" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_responses" ADD COLUMN "raw" jsonb;