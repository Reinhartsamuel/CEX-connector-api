ALTER TABLE "trading_plans" ALTER COLUMN "description" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_plans" ALTER COLUMN "strategy" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_plans" ALTER COLUMN "parameters" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_plans" ALTER COLUMN "visibility" DROP NOT NULL;