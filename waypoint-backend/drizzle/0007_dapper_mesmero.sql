ALTER TABLE "members" ADD COLUMN "first_day_of_week" text DEFAULT 'Sunday' NOT NULL;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "notification_prefs" jsonb;