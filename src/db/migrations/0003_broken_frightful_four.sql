ALTER TABLE "webhooks" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "order_updates" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "firebase_uid" varchar;
