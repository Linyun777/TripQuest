CREATE TABLE "chat_traces" (
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "chat_traces_conversation_id_seq_pk" PRIMARY KEY("conversation_id","seq"),
	CONSTRAINT "chat_traces_seq_check" CHECK ("chat_traces"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"category" text NOT NULL,
	"source_conversation_id" uuid,
	"created_at" timestamp (0) with time zone NOT NULL,
	"updated_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "preferences_text_check" CHECK ("preferences"."text" = btrim("preferences"."text") and char_length("preferences"."text") between 1 and 40),
	CONSTRAINT "preferences_category_check" CHECK ("preferences"."category" in ('food', 'pace', 'travel', 'interest', 'other')),
	CONSTRAINT "preferences_updated_at_check" CHECK ("preferences"."updated_at" >= "preferences"."created_at")
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" DROP CONSTRAINT "conversation_messages_kind_check";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary" jsonb;--> statement-breakpoint
ALTER TABLE "chat_traces" ADD CONSTRAINT "chat_traces_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_source_conversation_id_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_kind_check" CHECK ("conversation_messages"."kind" in ('text', 'requirements_card', 'planning_progress', 'plan_card', 'notice', 'choices', 'adjust_card', 'preference_proposal'));