ALTER TABLE "users" ALTER COLUMN "username" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ALTER COLUMN "status" SET DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "name" varchar(100);--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_hash";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "first_name";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "last_name";