CREATE TABLE "autotraders" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"exchange_id" integer NOT NULL,
	"trading_plan_id" integer,
	"market" text NOT NULL,
	"market_code" text,
	"pair" text,
	"status" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"initial_investment" numeric(10, 2) NOT NULL,
	"symbol" text NOT NULL,
	"position_mode" text NOT NULL,
	"margin_mode" text NOT NULL,
	"leverage" integer NOT NULL,
	"leverage_type" text,
	"autocompound" boolean DEFAULT false,
	"current_balance" numeric(10, 2) NOT NULL,
	CONSTRAINT "autotraders_user_id_exchange_id_trading_plan_id_symbol_unique" UNIQUE("user_id","exchange_id","trading_plan_id","symbol")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"payment_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"paid_at" timestamp with time zone,
	"amount" integer NOT NULL,
	"affiliate_user_id" integer,
	"firebase_uid" text NOT NULL,
	"metadata" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_name" text NOT NULL,
	"product_description" text NOT NULL,
	"product_attributes" text NOT NULL,
	"price" integer NOT NULL,
	"duration" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_plan_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"trading_plan_id" integer NOT NULL,
	"hashed_secret" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"rate_limit" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "trading_plan_pairs" (
	"id" serial PRIMARY KEY NOT NULL,
	"trading_plan_id" integer NOT NULL,
	"base_asset" text NOT NULL,
	"quote_asset" text NOT NULL,
	"symbol" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_user_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"strategy" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"visibility" text NOT NULL,
	"total_followers" integer DEFAULT 0,
	"pnl_30d" numeric(10, 2) NOT NULL,
	"max_dd" numeric(10, 2) NOT NULL,
	"sharpe" numeric(10, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"is_active" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_autotrader_balance_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"exchange_id" integer NOT NULL,
	"autotrader_id" integer NOT NULL,
	"balance" numeric(10, 2) NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_balances_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"exchange_id" integer NOT NULL,
	"balance" numeric(10, 2) NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_pnl_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"exchange_id" integer NOT NULL,
	"pnl" numeric(10, 2) NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "exchanges" ADD COLUMN "enc_dek" "bytea";--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "autotrader_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "autotraders" ADD CONSTRAINT "autotraders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autotraders" ADD CONSTRAINT "autotraders_exchange_id_exchanges_id_fk" FOREIGN KEY ("exchange_id") REFERENCES "public"."exchanges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autotraders" ADD CONSTRAINT "autotraders_trading_plan_id_trading_plans_id_fk" FOREIGN KEY ("trading_plan_id") REFERENCES "public"."trading_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_affiliate_user_id_users_id_fk" FOREIGN KEY ("affiliate_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_plan_keys" ADD CONSTRAINT "trading_plan_keys_trading_plan_id_trading_plans_id_fk" FOREIGN KEY ("trading_plan_id") REFERENCES "public"."trading_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_plan_pairs" ADD CONSTRAINT "trading_plan_pairs_trading_plan_id_trading_plans_id_fk" FOREIGN KEY ("trading_plan_id") REFERENCES "public"."trading_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_plans" ADD CONSTRAINT "trading_plans_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_autotrader_balance_snapshots" ADD CONSTRAINT "user_autotrader_balance_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_autotrader_balance_snapshots" ADD CONSTRAINT "user_autotrader_balance_snapshots_exchange_id_exchanges_id_fk" FOREIGN KEY ("exchange_id") REFERENCES "public"."exchanges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_autotrader_balance_snapshots" ADD CONSTRAINT "user_autotrader_balance_snapshots_autotrader_id_autotraders_id_fk" FOREIGN KEY ("autotrader_id") REFERENCES "public"."autotraders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_balances_snapshots" ADD CONSTRAINT "user_balances_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_balances_snapshots" ADD CONSTRAINT "user_balances_snapshots_exchange_id_exchanges_id_fk" FOREIGN KEY ("exchange_id") REFERENCES "public"."exchanges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_pnl_snapshots" ADD CONSTRAINT "user_pnl_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_pnl_snapshots" ADD CONSTRAINT "user_pnl_snapshots_exchange_id_exchanges_id_fk" FOREIGN KEY ("exchange_id") REFERENCES "public"."exchanges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "autotraders_trading_plan_id_symbol_status_index" ON "autotraders" USING btree ("trading_plan_id","symbol","status");--> statement-breakpoint
CREATE INDEX "autotraders_user_id_index" ON "autotraders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "autotraders_exchange_id_index" ON "autotraders" USING btree ("exchange_id");--> statement-breakpoint
CREATE INDEX "trading_plan_keys_trading_plan_id_index" ON "trading_plan_keys" USING btree ("trading_plan_id");--> statement-breakpoint
CREATE INDEX "trading_plan_keys_is_active_index" ON "trading_plan_keys" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "trading_plan_pairs_symbol_index" ON "trading_plan_pairs" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "trading_plans_owner_user_id_index" ON "trading_plans" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "trading_plans_visibility_index" ON "trading_plans" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "trading_plans_is_active_index" ON "trading_plans" USING btree ("is_active");--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_autotrader_id_autotraders_id_fk" FOREIGN KEY ("autotrader_id") REFERENCES "public"."autotraders"("id") ON DELETE cascade ON UPDATE no action;