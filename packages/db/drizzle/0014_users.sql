CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp (0) with time zone,
	"refresh_token_expires_at" timestamp (0) with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (0) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp (0) with time zone NOT NULL,
	"expires_at" timestamp (0) with time zone NOT NULL,
	"claimed_at" timestamp (0) with time zone,
	"used_by" uuid,
	"used_at" timestamp (0) with time zone,
	CONSTRAINT "invites_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "invites_code_hash_check" CHECK ("invites"."code_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "invites_expiry_check" CHECK ("invites"."expires_at" > "invites"."created_at")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limits_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp (0) with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (0) with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"category" text NOT NULL,
	"kind" text NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamp (0) with time zone NOT NULL,
	CONSTRAINT "usage_events_category_check" CHECK ("usage_events"."category" in ('amap', 'model', 'web', 'embed', 'jev')),
	CONSTRAINT "usage_events_text_check" CHECK (char_length("usage_events"."kind") between 1 and 40 and char_length("usage_events"."purpose") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "usage_limits" (
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"daily_limit" integer NOT NULL,
	CONSTRAINT "usage_limits_user_id_category_pk" PRIMARY KEY("user_id","category"),
	CONSTRAINT "usage_limits_category_check" CHECK ("usage_limits"."category" in ('amap', 'model', 'web', 'embed', 'jev')),
	CONSTRAINT "usage_limits_daily_check" CHECK ("usage_limits"."daily_limit" between 0 and 100000)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	"username" text,
	"display_username" text,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp (0) with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp (0) with time zone NOT NULL,
	"created_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (0) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "planning_tasks" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "user_id" uuid;--> statement-breakpoint
-- V2.12：现有数据全部归拥有者（用户名 owner，管理员；没有密码、不能登录，用 pnpm users set-password owner 设）。邮箱是不对外的占位地址。
INSERT INTO "users" ("id", "name", "email", "username", "display_username", "role", "banned", "created_at", "updated_at")
SELECT "id", 'owner', "id"::text || '@users.invalid', 'owner', 'owner', 'admin', false, now(), now()
FROM (SELECT gen_random_uuid() AS "id") AS "generated";--> statement-breakpoint
UPDATE "conversations" SET "user_id" = (SELECT "id" FROM "users" WHERE "username" = 'owner');--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
UPDATE "journeys" SET "user_id" = (SELECT "id" FROM "users" WHERE "username" = 'owner');--> statement-breakpoint
ALTER TABLE "journeys" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
UPDATE "planning_tasks" SET "user_id" = (SELECT "id" FROM "users" WHERE "username" = 'owner');--> statement-breakpoint
ALTER TABLE "planning_tasks" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
UPDATE "preferences" SET "user_id" = (SELECT "id" FROM "users" WHERE "username" = 'owner');--> statement-breakpoint
ALTER TABLE "preferences" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
UPDATE "trips" SET "user_id" = (SELECT "id" FROM "users" WHERE "username" = 'owner');--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_limits" ADD CONSTRAINT "usage_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "usage_events_user_day_idx" ON "usage_events" USING btree ("user_id","day","category");--> statement-breakpoint
CREATE INDEX "usage_events_day_idx" ON "usage_events" USING btree ("day","category");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_tasks" ADD CONSTRAINT "planning_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_user_idx" ON "conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "journeys_user_idx" ON "journeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "planning_tasks_user_idx" ON "planning_tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "preferences_user_idx" ON "preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trips_user_idx" ON "trips" USING btree ("user_id");