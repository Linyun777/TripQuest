ALTER TABLE "journeys" ADD COLUMN "city_adcode" text DEFAULT '330100' NOT NULL;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "city_name" text DEFAULT '杭州市' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "city_adcode" text DEFAULT '330100' NOT NULL;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_city_check" CHECK ("journeys"."city_adcode" ~ '^[0-9]{6}$' and char_length("journeys"."city_name") between 1 and 40);--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_city_check" CHECK ("knowledge_documents"."city_adcode" ~ '^[0-9]{6}$');