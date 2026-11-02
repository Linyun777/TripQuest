ALTER TABLE "journeys" DROP CONSTRAINT "journeys_creation_identity_check";--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_creation_identity_check" CHECK (
      ("journeys"."creation_kind" = 'manual'
        and "journeys"."creation_run_id" is null and "journeys"."creation_intent_fingerprint" is null)
      or ("journeys"."creation_kind" in ('generated_day', 'real_day')
        and "journeys"."creation_run_id" is not null
        and "journeys"."creation_intent_fingerprint" is not null
        and "journeys"."creation_intent_fingerprint" ~ '^[a-f0-9]{64}$')
    );