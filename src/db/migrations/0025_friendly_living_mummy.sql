ALTER TABLE "autotraders" ADD COLUMN "webhook_token" text;--> statement-breakpoint
ALTER TABLE "autotraders" ADD CONSTRAINT "autotraders_webhook_token_unique" UNIQUE("webhook_token");