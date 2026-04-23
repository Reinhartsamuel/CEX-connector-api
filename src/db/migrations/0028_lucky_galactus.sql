ALTER TABLE "trading_plan_keys" RENAME COLUMN "hashed_secret" TO "secret_hash";--> statement-breakpoint
ALTER TABLE "autotraders" ADD COLUMN "trading_plan_pair_id" integer;--> statement-breakpoint
ALTER TABLE "trading_plan_keys" ADD COLUMN "key_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "trading_plan_id" integer;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "batch_id" text;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "autotraders" ADD CONSTRAINT "autotraders_trading_plan_pair_id_trading_plan_pairs_id_fk" FOREIGN KEY ("trading_plan_pair_id") REFERENCES "public"."trading_plan_pairs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_trading_plan_id_trading_plans_id_fk" FOREIGN KEY ("trading_plan_id") REFERENCES "public"."trading_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhooks_batch_id_index" ON "webhooks" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "webhooks_trading_plan_id_index" ON "webhooks" USING btree ("trading_plan_id");--> statement-breakpoint
ALTER TABLE "trading_plan_keys" ADD CONSTRAINT "trading_plan_keys_key_hash_unique" UNIQUE("key_hash");--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_dedupe_key_unique" UNIQUE("dedupe_key");