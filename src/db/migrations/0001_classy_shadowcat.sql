ALTER TABLE "trades" ADD COLUMN "take_profit_executed" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "stop_loss_executed" boolean DEFAULT false;