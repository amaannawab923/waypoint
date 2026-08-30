ALTER TABLE "copilot_conversations" DROP CONSTRAINT "copilot_conversations_member_id_unique";--> statement-breakpoint
ALTER TABLE "copilot_conversations" ADD COLUMN "title" text DEFAULT 'New session' NOT NULL;--> statement-breakpoint
CREATE INDEX "copilot_conversations_member_id_updated_at_idx" ON "copilot_conversations" USING btree ("member_id","updated_at");