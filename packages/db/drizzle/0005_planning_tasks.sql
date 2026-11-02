CREATE TABLE "planning_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"journey_id" uuid,
	"request_key" uuid NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"input" json NOT NULL,
	"status" text NOT NULL,
	"progress" json,
	"result" json,
	"offer" json,
	"stop_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp (0) with time zone,
	"cancel_requested_at" timestamp (0) with time zone,
	"deadline_at" timestamp (0) with time zone NOT NULL,
	"created_at" timestamp (0) with time zone NOT NULL,
	"started_at" timestamp (0) with time zone,
	"finished_at" timestamp (0) with time zone,
	CONSTRAINT "planning_tasks_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "planning_tasks_kind_check" CHECK (
      ("planning_tasks"."kind" = 'day_draft' and "planning_tasks"."journey_id" is null)
      or ("planning_tasks"."kind" = 'day_replan' and "planning_tasks"."journey_id" is not null)
    ),
	CONSTRAINT "planning_tasks_status_check" CHECK ("planning_tasks"."status" in ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "planning_tasks_stop_reason_check" CHECK ("planning_tasks"."stop_reason" is null or "planning_tasks"."stop_reason" in ('cancelled', 'deadline', 'worker_lost')),
	CONSTRAINT "planning_tasks_attempts_check" CHECK ("planning_tasks"."attempts" between 0 and 3),
	CONSTRAINT "planning_tasks_fingerprint_check" CHECK ("planning_tasks"."intent_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "planning_tasks_lease_check" CHECK (
      ("planning_tasks"."status" = 'running') = ("planning_tasks"."lease_token" is not null)
      and ("planning_tasks"."lease_token" is null) = ("planning_tasks"."lease_expires_at" is null)
      and ("planning_tasks"."lease_token" is null) = ("planning_tasks"."lease_owner" is null)
    ),
	CONSTRAINT "planning_tasks_terminal_check" CHECK (
      ("planning_tasks"."status" in ('completed', 'failed', 'cancelled')) = ("planning_tasks"."finished_at" is not null)
      and ("planning_tasks"."status" <> 'completed' or "planning_tasks"."result" is not null)
      and ("planning_tasks"."status" not in ('failed', 'cancelled') or "planning_tasks"."result" is not null or "planning_tasks"."stop_reason" is not null)
      and ("planning_tasks"."offer" is null or "planning_tasks"."status" = 'completed')
    )
);
--> statement-breakpoint
ALTER TABLE "planning_tasks" ADD CONSTRAINT "planning_tasks_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "planning_tasks_claim_idx" ON "planning_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "planning_tasks_finished_idx" ON "planning_tasks" USING btree ("finished_at");