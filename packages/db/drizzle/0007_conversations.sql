CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "conversation_messages_seq_unique" UNIQUE("conversation_id","seq"),
	CONSTRAINT "conversation_messages_seq_check" CHECK ("conversation_messages"."seq" > 0),
	CONSTRAINT "conversation_messages_role_check" CHECK ("conversation_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "conversation_messages_kind_check" CHECK ("conversation_messages"."kind" in ('text', 'requirements_card', 'planning_progress', 'plan_card', 'notice'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"journey_id" uuid,
	"draft" jsonb NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (0) with time zone NOT NULL,
	"updated_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "conversations_title_length_check" CHECK ("conversations"."title" = btrim("conversations"."title") and char_length("conversations"."title") between 1 and 80),
	CONSTRAINT "conversations_status_check" CHECK ("conversations"."status" in ('active', 'planned', 'archived')),
	CONSTRAINT "conversations_message_count_check" CHECK ("conversations"."message_count" >= 0),
	CONSTRAINT "conversations_updated_at_check" CHECK ("conversations"."updated_at" >= "conversations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_updated_idx" ON "conversations" USING btree ("updated_at");