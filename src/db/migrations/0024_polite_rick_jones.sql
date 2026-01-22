ALTER TABLE "trades" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "cancel_reason" text;