ALTER TABLE "trading_plans" ALTER COLUMN "pnl_30d" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_plans" ALTER COLUMN "max_dd" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_plans" ALTER COLUMN "sharpe" DROP NOT NULL;