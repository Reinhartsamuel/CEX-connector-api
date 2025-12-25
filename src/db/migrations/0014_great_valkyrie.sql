ALTER TABLE "exchanges" ADD COLUMN "api_passphrase" text;--> statement-breakpoint
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_exchange_user_id_unique" UNIQUE("exchange_user_id");