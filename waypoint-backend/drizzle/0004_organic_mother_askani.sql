CREATE TYPE "public"."copilot_proposal_kind" AS ENUM('comment', 'state_change', 'assignee_change', 'priority_change', 'create_work_item');--> statement-breakpoint
CREATE TYPE "public"."copilot_proposal_status" AS ENUM('proposed', 'executing', 'executed', 'rejected', 'stale', 'expired', 'superseded');--> statement-breakpoint
CREATE TABLE "copilot_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"kind" "copilot_proposal_kind" NOT NULL,
	"work_item_id" text,
	"payload" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"anchor_seq" bigint NOT NULL,
	"status" "copilot_proposal_status" DEFAULT 'proposed' NOT NULL,
	"status_reason" text,
	"result_info" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"model_notified_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copilot_proposals" ADD CONSTRAINT "copilot_proposals_conversation_id_copilot_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."copilot_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "copilot_proposals_conversation_id_created_at_idx" ON "copilot_proposals" USING btree ("conversation_id","created_at");