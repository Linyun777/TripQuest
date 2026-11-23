ALTER TABLE "usage_events" ADD COLUMN "child_run_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "meter_status" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "requested_model" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "returned_model" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "tokens" jsonb;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "price" jsonb;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "amount" numeric;