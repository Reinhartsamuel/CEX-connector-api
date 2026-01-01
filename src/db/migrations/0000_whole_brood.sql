CREATE TABLE "exchanges" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"exchange_title" varchar(100) NOT NULL,
	"api_key" varchar(500) NOT NULL,
	"api_secret" varchar(500) NOT NULL,
	"is_active" boolean DEFAULT true,
	"testnet" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "exchanges_user_id_exchange_title_unique" UNIQUE("user_id","exchange_title")
);
--> statement-breakpoint
CREATE TABLE "order_updates" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"exchange_id" bigint NOT NULL,
	"trade_id" bigint,
	"exchange_trade_id" varchar(255) NOT NULL,
	"update_type" varchar(50) NOT NULL,
	"status" varchar(50) NOT NULL,
	"size" numeric(20, 8),
	"filled_size" numeric(20, 8),
	"price" numeric(20, 8),
	"average_price" numeric(20, 8),
	"update_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"exchange_id" bigint NOT NULL,
	"trade_id" varchar(255) NOT NULL,
	"contract" varchar(100) NOT NULL,
	"position_type" varchar(10) NOT NULL,
	"market_type" varchar(10) NOT NULL,
	"size" numeric(20, 8) NOT NULL,
	"price" numeric(20, 8),
	"leverage" integer NOT NULL,
	"leverage_type" varchar(20) NOT NULL,
	"status" varchar(50) NOT NULL,
	"reduce_only" boolean DEFAULT false,
	"take_profit_enabled" boolean DEFAULT false,
	"take_profit_price" numeric(20, 8),
	"take_profit_price_type" varchar(10),
	"stop_loss_enabled" boolean DEFAULT false,
	"stop_loss_price" numeric(20, 8),
	"stop_loss_price_type" varchar(10),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),

);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "webhook_responses" (
	"id" serial PRIMARY KEY NOT NULL,
	"webhook_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"exchange_id" bigint NOT NULL,
	"trade_id" bigint,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"error_message" text,
	"processed_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"exchange_id" bigint NOT NULL,
	"action" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(50) DEFAULT 'pending',
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "exchanges" ADD CONSTRAINT "exchanges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_updates" ADD CONSTRAINT "order_updates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_updates" ADD CONSTRAINT "order_updates_exchange_id_exchanges_id_fk" FOREIGN KEY ("exchange_id") REFERENCES "public"."exchanges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_updates" ADD CONSTRAINT "order_updates_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_exchange_id_exchanges_id_fk" FOREIGN KEY ("exchange_id") REFERENCES "public"."exchanges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_responses" ADD CONSTRAINT "webhook_responses_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_responses" ADD CONSTRAINT "webhook_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_responses" ADD CONSTRAINT "webhook_responses_exchange_id_exchanges_id_fk" FOREIGN KEY ("exchange_id") REFERENCES "public"."exchanges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_responses" ADD CONSTRAINT "webhook_responses_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_exchange_id_exchanges_id_fk" FOREIGN KEY ("exchange_id") REFERENCES "public"."exchanges"("id") ON DELETE cascade ON UPDATE no action;
