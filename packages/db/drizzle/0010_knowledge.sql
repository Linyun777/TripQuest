CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"seq" integer NOT NULL,
	"heading_path" text NOT NULL,
	"body" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"keywords" text NOT NULL,
	"keyword_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', keywords)) STORED NOT NULL,
	CONSTRAINT "knowledge_chunks_seq_unique" UNIQUE("document_id","seq"),
	CONSTRAINT "knowledge_chunks_seq_check" CHECK ("knowledge_chunks"."seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"topic" text NOT NULL,
	"sources" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"ingested_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "knowledge_documents_id_check" CHECK ("knowledge_documents"."id" ~ '^[a-z0-9-]{1,80}$')
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_chunks_keyword_idx" ON "knowledge_chunks" USING gin ("keyword_vector");