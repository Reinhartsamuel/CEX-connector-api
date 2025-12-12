ALTER TABLE "trades" ADD COLUMN "open_order_id" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "open_fill_price" varchar(255);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "open_filled_at" integer;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "close_order_id" varchar;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "close_filled_at" integer;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "close_reason" varchar;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "position_status" varchar;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "is_tpsl" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "tpsl_type" varchar(255);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "parent_trade_id" integer;