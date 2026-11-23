CREATE TABLE "site_usage_limits" (
	"category" text PRIMARY KEY NOT NULL,
	"daily_limit" integer NOT NULL,
	"updated_at" timestamp (0) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_usage_limits_category_check" CHECK ("site_usage_limits"."category" in ('amap', 'model', 'web', 'embed', 'jev')),
	CONSTRAINT "site_usage_limits_daily_check" CHECK ("site_usage_limits"."daily_limit" between 0 and 100000)
);
