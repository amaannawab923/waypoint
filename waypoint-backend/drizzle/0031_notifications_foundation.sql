ALTER TYPE "public"."notification_kind" ADD VALUE 'reply';--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "message" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "comment_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "group_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Backfill (hand-added after generate): carry the old read flag into read_at, and give existing
-- rows their creation time as their sort key, before "read" is dropped below.
UPDATE "notifications" SET "read_at" = CASE WHEN "read" THEN "created_at" END, "updated_at" = "created_at";--> statement-breakpoint
CREATE INDEX "notifications_recipient_updated_idx" ON "notifications" USING btree ("recipient_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("recipient_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_open_group_uq" ON "notifications" USING btree ("recipient_id","group_key") WHERE "notifications"."read_at" IS NULL AND "notifications"."group_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "read";