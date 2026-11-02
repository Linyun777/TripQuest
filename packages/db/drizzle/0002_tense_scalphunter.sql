CREATE TABLE "day_plan_details" (
	"journey_id" uuid NOT NULL,
	"plan_version" integer NOT NULL,
	"details" jsonb NOT NULL,
	CONSTRAINT "day_plan_details_pkey" PRIMARY KEY("journey_id","plan_version"),
	CONSTRAINT "day_plan_details_version_check" CHECK ("day_plan_details"."plan_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "creation_kind" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "creation_run_id" uuid;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "creation_intent_fingerprint" text;--> statement-breakpoint
ALTER TABLE "day_plan_details" ADD CONSTRAINT "day_plan_details_plan_version_fk" FOREIGN KEY ("journey_id","plan_version") REFERENCES "public"."plan_versions"("journey_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_creation_run_id_unique" UNIQUE("creation_run_id");--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_creation_identity_check" CHECK (
      ("journeys"."creation_kind" = 'manual'
        and "journeys"."creation_run_id" is null and "journeys"."creation_intent_fingerprint" is null)
      or ("journeys"."creation_kind" = 'generated_day'
        and "journeys"."creation_run_id" is not null
        and "journeys"."creation_intent_fingerprint" is not null
        and "journeys"."creation_intent_fingerprint" ~ '^[a-f0-9]{64}$')
    );