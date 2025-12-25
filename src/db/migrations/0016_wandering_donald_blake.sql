ALTER TABLE "exchanges" RENAME COLUMN "api_key" TO "api_key_ecrypted";--> statement-breakpoint
ALTER TABLE "exchanges" RENAME COLUMN "api_secret" TO "api_secret_ecrypted";--> statement-breakpoint
ALTER TABLE "exchanges" RENAME COLUMN "api_passphrase" TO "api_passphrase_encrypted";