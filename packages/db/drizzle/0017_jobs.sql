CREATE TABLE "conversation_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"request_key" uuid NOT NULL,
	"status" text NOT NULL,
	"steps" jsonb NOT NULL,
	"days" jsonb NOT NULL,
	"planned" jsonb NOT NULL,
	"root_run_id" uuid,
	"started_at" timestamp (3) with time zone NOT NULL,
	"heartbeat_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone,
	CONSTRAINT "conversation_jobs_request_unique" UNIQUE("conversation_id","request_key"),
	CONSTRAINT "conversation_jobs_kind_check" CHECK ("conversation_jobs"."kind" in ('plan', 'outing', 'outing_change', 'adjust')),
	CONSTRAINT "conversation_jobs_status_check" CHECK ("conversation_jobs"."status" in ('running', 'done', 'failed', 'cancelled', 'interrupted'))
);
--> statement-breakpoint
ALTER TABLE "conversation_jobs" ADD CONSTRAINT "conversation_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_jobs" ADD CONSTRAINT "conversation_jobs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_jobs_one_running" ON "conversation_jobs" USING btree ("conversation_id") WHERE "conversation_jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "conversation_jobs_conversation_idx" ON "conversation_jobs" USING btree ("conversation_id","started_at");--> statement-breakpoint
CREATE INDEX "conversation_jobs_user_idx" ON "conversation_jobs" USING btree ("user_id");