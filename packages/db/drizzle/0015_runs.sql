CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"root_id" uuid NOT NULL,
	"parent_id" uuid,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"journey_id" uuid,
	"trip_id" uuid,
	"agent" text NOT NULL,
	"agent_version" text,
	"trigger" text,
	"status" text NOT NULL,
	"outcome" text,
	"attributes" jsonb NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone,
	"model_requests" integer NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_hit_tokens" integer NOT NULL,
	"map_requests" integer NOT NULL,
	"web_requests" integer NOT NULL,
	"knowledge_requests" integer NOT NULL,
	"jev_requests" integer NOT NULL,
	CONSTRAINT "agent_runs_status_check" CHECK ("agent_runs"."status" in ('running', 'ok', 'none', 'failed', 'fallback', 'budget_exhausted', 'cancelled')),
	CONSTRAINT "agent_runs_text_check" CHECK (char_length("agent_runs"."agent") between 1 and 40 and char_length(coalesce("agent_runs"."outcome", '')) <= 80)
);
--> statement-breakpoint
CREATE TABLE "agent_steps" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"latency_ms" integer,
	"summary" jsonb NOT NULL,
	"at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "agent_steps_run_id_seq_pk" PRIMARY KEY("run_id","seq"),
	CONSTRAINT "agent_steps_kind_check" CHECK ("agent_steps"."kind" in ('model_call', 'tool_call', 'check', 'repair', 'handoff', 'fallback'))
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_root_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_root_idx" ON "agent_runs" USING btree ("root_id");--> statement-breakpoint
CREATE INDEX "agent_runs_user_idx" ON "agent_runs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_conversation_idx" ON "agent_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "usage_events_run_idx" ON "usage_events" USING btree ("run_id");