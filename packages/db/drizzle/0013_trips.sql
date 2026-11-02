CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"generation_id" uuid NOT NULL,
	"title" text NOT NULL,
	"first_date" date NOT NULL,
	"last_date" date NOT NULL,
	"details" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (0) with time zone NOT NULL,
	"updated_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "trips_generation_id_unique" UNIQUE("generation_id"),
	CONSTRAINT "trips_title_length_check" CHECK ("trips"."title" = btrim("trips"."title") and char_length("trips"."title") between 1 and 80),
	CONSTRAINT "trips_dates_check" CHECK ("trips"."last_date" >= "trips"."first_date" and "trips"."last_date" - "trips"."first_date" <= 6),
	CONSTRAINT "trips_version_check" CHECK ("trips"."version" >= 1),
	CONSTRAINT "trips_updated_at_check" CHECK ("trips"."updated_at" >= "trips"."created_at")
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" DROP CONSTRAINT "conversation_messages_kind_check";--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "trip_id" uuid;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "trip_day" integer;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "trip_part" integer;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_trip_part_unique" UNIQUE("trip_id","trip_day","trip_part");--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_kind_check" CHECK ("conversation_messages"."kind" in ('text', 'requirements_card', 'planning_progress', 'plan_card', 'notice', 'choices', 'adjust_card', 'preference_proposal', 'outing_day', 'outing_change'));--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_trip_check" CHECK (
      ("journeys"."trip_id" is null and "journeys"."trip_day" is null and "journeys"."trip_part" is null)
      or ("journeys"."trip_id" is not null and "journeys"."trip_day" between 1 and 7 and "journeys"."trip_part" between 0 and 6)
    );