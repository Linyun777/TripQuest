CREATE TABLE "user_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"page_path" text,
	"context_label" text,
	"conversation_id" uuid,
	"journey_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp (0) with time zone,
	CONSTRAINT "user_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "user_feedback_category_check" CHECK ("user_feedback"."category" in ('plan_issue', 'ui_bug', 'suggestion', 'other')),
	CONSTRAINT "user_feedback_status_check" CHECK ("user_feedback"."status" in ('open', 'resolved')),
	CONSTRAINT "user_feedback_content_check" CHECK (char_length(btrim("user_feedback"."content")) between 1 and 1000),
	CONSTRAINT "user_feedback_page_path_check" CHECK ("user_feedback"."page_path" is null or (left("user_feedback"."page_path", 1) = '/' and char_length("user_feedback"."page_path") <= 160)),
	CONSTRAINT "user_feedback_context_label_check" CHECK ("user_feedback"."context_label" is null or char_length("user_feedback"."context_label") <= 80)
);
--> statement-breakpoint
CREATE INDEX "user_feedback_status_created_idx" ON "user_feedback" USING btree ("status","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "user_feedback_user_created_idx" ON "user_feedback" USING btree ("user_id","created_at" DESC);
