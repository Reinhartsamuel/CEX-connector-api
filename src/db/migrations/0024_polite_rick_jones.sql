ALTER TABLE "trades" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "cancel_reason" text;
ALTER TABLE exchanges DROP CONSTRAINT exchanges_user_id_exchange_title_unique;