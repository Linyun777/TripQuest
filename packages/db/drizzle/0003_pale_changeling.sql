CREATE TABLE "generated_day_edit_confirmations" (
	"journey_id" uuid NOT NULL,
	"edit_id" uuid NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"base_plan_version" integer NOT NULL,
	"base_observation_version" integer NOT NULL,
	"result_plan_version" integer NOT NULL,
	"change" jsonb NOT NULL,
	"candidate_fingerprint" text NOT NULL,
	"confirmed_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "generated_day_edit_confirmations_pkey" PRIMARY KEY("journey_id","edit_id"),
	CONSTRAINT "generated_day_edits_versions_check" CHECK (
    "generated_day_edit_confirmations"."base_plan_version" > 0 and "generated_day_edit_confirmations"."base_observation_version" = 0
    and "generated_day_edit_confirmations"."result_plan_version" = "generated_day_edit_confirmations"."base_plan_version" + 1
  ),
	CONSTRAINT "generated_day_edits_fingerprints_check" CHECK (
    "generated_day_edit_confirmations"."intent_fingerprint" ~ '^[a-f0-9]{64}$' and "generated_day_edit_confirmations"."candidate_fingerprint" ~ '^[a-f0-9]{64}$'
  )
);
--> statement-breakpoint
ALTER TABLE "generated_day_edit_confirmations" ADD CONSTRAINT "generated_day_edit_confirmations_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_day_edit_confirmations" ADD CONSTRAINT "generated_day_edits_base_plan_fk" FOREIGN KEY ("journey_id","base_plan_version") REFERENCES "public"."plan_versions"("journey_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_day_edit_confirmations" ADD CONSTRAINT "generated_day_edits_result_plan_fk" FOREIGN KEY ("journey_id","result_plan_version") REFERENCES "public"."plan_versions"("journey_id","version") ON DELETE no action ON UPDATE no action;