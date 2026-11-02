CREATE TABLE "journey_observations" (
	"journey_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"observed_at" timestamp (0) with time zone NOT NULL,
	"completed_activity_ids" uuid[] NOT NULL,
	"skipped_activity_ids" uuid[] NOT NULL,
	"current_activity_id" uuid,
	"location_place_id" uuid NOT NULL,
	"source" text NOT NULL,
	"recorded_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "journey_observations_pkey" PRIMARY KEY("journey_id","version"),
	CONSTRAINT "journey_observations_version_check" CHECK ("journey_observations"."version" > 0),
	CONSTRAINT "journey_observations_source_check" CHECK ("journey_observations"."source" = 'user_reported'),
	CONSTRAINT "journey_observations_current_activity_check" CHECK ("journey_observations"."current_activity_id" is null),
	CONSTRAINT "journey_observations_skipped_check" CHECK (cardinality("journey_observations"."skipped_activity_ids") = 0)
);
--> statement-breakpoint
CREATE TABLE "plan_confirmations" (
	"journey_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"base_plan_version" integer NOT NULL,
	"base_observation_version" integer NOT NULL,
	"result_plan_version" integer NOT NULL,
	"result_observation_version" integer NOT NULL,
	"normalized_input" jsonb NOT NULL,
	"strategy" text NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"travel_source" text NOT NULL,
	"transfer_buffer_minutes" integer NOT NULL,
	"confirmed_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "plan_confirmations_pkey" PRIMARY KEY("journey_id","idempotency_key"),
	CONSTRAINT "plan_confirmations_versions_check" CHECK ("plan_confirmations"."base_plan_version" > 0 and "plan_confirmations"."base_observation_version" >= 0 and "plan_confirmations"."result_plan_version" = "plan_confirmations"."base_plan_version" + 1 and "plan_confirmations"."result_observation_version" = "plan_confirmations"."base_observation_version" + 1),
	CONSTRAINT "plan_confirmations_strategy_check" CHECK ("plan_confirmations"."strategy" in ('shift', 'omit')),
	CONSTRAINT "plan_confirmations_travel_source_check" CHECK ("plan_confirmations"."travel_source" in ('user_estimate', 'same_place')),
	CONSTRAINT "plan_confirmations_buffer_check" CHECK ("plan_confirmations"."transfer_buffer_minutes" = 10)
);
--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "current_observation_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "journey_observations" ADD CONSTRAINT "journey_observations_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_confirmations" ADD CONSTRAINT "plan_confirmations_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_confirmations" ADD CONSTRAINT "plan_confirmations_result_plan_fkey" FOREIGN KEY ("journey_id","result_plan_version") REFERENCES "public"."plan_versions"("journey_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_confirmations" ADD CONSTRAINT "plan_confirmations_result_observation_fkey" FOREIGN KEY ("journey_id","result_observation_version") REFERENCES "public"."journey_observations"("journey_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_observation_version_check" CHECK ("journeys"."current_observation_version" >= 0);