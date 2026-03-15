ALTER TABLE "webhooks" ADD COLUMN "autotrader_id" integer REFERENCES "autotraders"("id") ON DELETE set null;
ALTER TABLE "webhooks" ADD COLUMN "error_message" text;
