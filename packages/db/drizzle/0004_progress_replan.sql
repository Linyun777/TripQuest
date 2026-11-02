CREATE TABLE "generated_day_progress" (
	"journey_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"previous_version" integer NOT NULL,
	"base_plan_version" integer NOT NULL,
	"report_id" uuid NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"observed_at" timestamp (0) with time zone NOT NULL,
	"earliest_resume_at" timestamp (0) with time zone NOT NULL,
	"completed_activity_ids" uuid[] NOT NULL,
	"skipped_activity_ids" uuid[] NOT NULL,
	"location_place_id" uuid,
	"source" text NOT NULL,
	"recorded_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "generated_day_progress_pkey" PRIMARY KEY("journey_id","version"),
	CONSTRAINT "generated_day_progress_report_unique" UNIQUE("journey_id","report_id"),
	CONSTRAINT "generated_day_progress_versions_check" CHECK ("generated_day_progress"."version" > 0 and "generated_day_progress"."previous_version" = "generated_day_progress"."version" - 1 and "generated_day_progress"."base_plan_version" > 0),
	CONSTRAINT "generated_day_progress_times_check" CHECK ("generated_day_progress"."earliest_resume_at" >= "generated_day_progress"."observed_at"),
	CONSTRAINT "generated_day_progress_sets_check" CHECK (cardinality("generated_day_progress"."completed_activity_ids") <= 6 and cardinality("generated_day_progress"."skipped_activity_ids") <= 6
        and not ("generated_day_progress"."completed_activity_ids" && "generated_day_progress"."skipped_activity_ids")),
	CONSTRAINT "generated_day_progress_source_check" CHECK ("generated_day_progress"."source" = 'user_reported'),
	CONSTRAINT "generated_day_progress_fingerprint_check" CHECK ("generated_day_progress"."intent_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "generated_day_replan_confirmations" (
	"journey_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"base_plan_version" integer NOT NULL,
	"base_observation_version" integer NOT NULL,
	"result_plan_version" integer NOT NULL,
	"confirmed_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "generated_day_replan_confirmations_pkey" PRIMARY KEY("journey_id","run_id"),
	CONSTRAINT "generated_day_replans_versions_check" CHECK ("generated_day_replan_confirmations"."base_plan_version" > 0 and "generated_day_replan_confirmations"."base_observation_version" > 0
        and "generated_day_replan_confirmations"."result_plan_version" = "generated_day_replan_confirmations"."base_plan_version" + 1),
	CONSTRAINT "generated_day_replans_fingerprint_check" CHECK ("generated_day_replan_confirmations"."intent_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "generated_day_progress" ADD CONSTRAINT "generated_day_progress_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_day_progress" ADD CONSTRAINT "generated_day_progress_base_plan_fk" FOREIGN KEY ("journey_id","base_plan_version") REFERENCES "public"."plan_versions"("journey_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_day_replan_confirmations" ADD CONSTRAINT "generated_day_replan_confirmations_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_day_replan_confirmations" ADD CONSTRAINT "generated_day_replans_base_plan_fk" FOREIGN KEY ("journey_id","base_plan_version") REFERENCES "public"."plan_versions"("journey_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_day_replan_confirmations" ADD CONSTRAINT "generated_day_replans_result_plan_fk" FOREIGN KEY ("journey_id","result_plan_version") REFERENCES "public"."plan_versions"("journey_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_day_replan_confirmations" ADD CONSTRAINT "generated_day_replans_base_progress_fk" FOREIGN KEY ("journey_id","base_observation_version") REFERENCES "public"."generated_day_progress"("journey_id","version") ON DELETE no action ON UPDATE no action;