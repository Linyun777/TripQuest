CREATE TABLE "journeys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"date" date NOT NULL,
	"time_zone" text NOT NULL,
	"created_at" timestamp (0) with time zone NOT NULL,
	"updated_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "journeys_title_length_check" CHECK ("journeys"."title" = btrim("journeys"."title") and char_length("journeys"."title") between 1 and 80),
	CONSTRAINT "journeys_time_zone_check" CHECK ("journeys"."time_zone" = 'Asia/Shanghai'),
	CONSTRAINT "journeys_updated_at_check" CHECK ("journeys"."updated_at" >= "journeys"."created_at")
);
--> statement-breakpoint
CREATE TABLE "plan_activities" (
	"journey_id" uuid NOT NULL,
	"plan_version" integer NOT NULL,
	"activity_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"place_id" uuid NOT NULL,
	"place_name" text NOT NULL,
	"starts_at" timestamp (0) with time zone NOT NULL,
	"ends_at" timestamp (0) with time zone NOT NULL,
	"priority" text NOT NULL,
	"locked" boolean NOT NULL,
	"reservation_id" uuid,
	CONSTRAINT "plan_activities_pkey" PRIMARY KEY("journey_id","plan_version","activity_id"),
	CONSTRAINT "plan_activities_position_unique" UNIQUE("journey_id","plan_version","position"),
	CONSTRAINT "plan_activities_position_check" CHECK ("plan_activities"."position" >= 0),
	CONSTRAINT "plan_activities_place_name_length_check" CHECK ("plan_activities"."place_name" = btrim("plan_activities"."place_name") and char_length("plan_activities"."place_name") between 1 and 80),
	CONSTRAINT "plan_activities_time_window_check" CHECK ("plan_activities"."starts_at" < "plan_activities"."ends_at"),
	CONSTRAINT "plan_activities_priority_check" CHECK ("plan_activities"."priority" in ('high', 'normal', 'low')),
	CONSTRAINT "plan_activities_reservation_lock_check" CHECK ("plan_activities"."reservation_id" is null or ("plan_activities"."locked" = true and "plan_activities"."priority" = 'high'))
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"journey_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"parent_version" integer,
	"change_reason" text,
	"is_current" boolean NOT NULL,
	"created_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "plan_versions_pkey" PRIMARY KEY("journey_id","version"),
	CONSTRAINT "plan_versions_version_check" CHECK ("plan_versions"."version" > 0),
	CONSTRAINT "plan_versions_parent_version_check" CHECK ("plan_versions"."parent_version" is null or ("plan_versions"."parent_version" > 0 and "plan_versions"."parent_version" < "plan_versions"."version")),
	CONSTRAINT "plan_versions_change_reason_check" CHECK ("plan_versions"."change_reason" is null or ("plan_versions"."change_reason" = btrim("plan_versions"."change_reason") and char_length("plan_versions"."change_reason") > 0))
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"journey_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"place_name" text NOT NULL,
	"starts_at" timestamp (0) with time zone NOT NULL,
	"ends_at" timestamp (0) with time zone NOT NULL,
	"confirmation_status" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_reference" text,
	"recorded_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "reservations_journey_id_id_unique" UNIQUE("journey_id","id"),
	CONSTRAINT "reservations_place_name_length_check" CHECK ("reservations"."place_name" = btrim("reservations"."place_name") and char_length("reservations"."place_name") between 1 and 80),
	CONSTRAINT "reservations_time_window_check" CHECK ("reservations"."starts_at" < "reservations"."ends_at"),
	CONSTRAINT "reservations_confirmation_status_check" CHECK ("reservations"."confirmation_status" in ('confirmed', 'pending', 'cancelled', 'unknown')),
	CONSTRAINT "reservations_source_kind_check" CHECK ("reservations"."source_kind" in ('fixture', 'user_reported', 'provider_record'))
);
--> statement-breakpoint
ALTER TABLE "plan_activities" ADD CONSTRAINT "plan_activities_plan_version_fkey" FOREIGN KEY ("journey_id","plan_version") REFERENCES "public"."plan_versions"("journey_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_activities" ADD CONSTRAINT "plan_activities_reservation_fkey" FOREIGN KEY ("journey_id","reservation_id") REFERENCES "public"."reservations"("journey_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_parent_fkey" FOREIGN KEY ("journey_id","parent_version") REFERENCES "public"."plan_versions"("journey_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_activities_reservation_idx" ON "plan_activities" USING btree ("journey_id","reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_versions_one_current_per_journey" ON "plan_versions" USING btree ("journey_id") WHERE "plan_versions"."is_current" = true;--> statement-breakpoint
CREATE INDEX "reservations_journey_id_idx" ON "reservations" USING btree ("journey_id");