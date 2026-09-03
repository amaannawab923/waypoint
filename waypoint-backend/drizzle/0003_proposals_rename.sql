ALTER TYPE "public"."copilot_proposal_kind" RENAME TO "proposal_kind";--> statement-breakpoint
ALTER TYPE "public"."copilot_proposal_status" RENAME TO "proposal_status";--> statement-breakpoint
ALTER TABLE "copilot_proposals" RENAME TO "proposals";--> statement-breakpoint
ALTER TABLE "proposals" DROP CONSTRAINT "copilot_proposals_conversation_id_copilot_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_conversation_id_copilot_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."copilot_conversations"("id") ON DELETE cascade ON UPDATE no action;