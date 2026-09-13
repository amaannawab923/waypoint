ALTER TYPE "public"."copilot_message_role" ADD VALUE 'system';--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "intent" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "copilot_conversation_id" text;--> statement-breakpoint
ALTER TABLE "copilot_messages" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_copilot_conversation_id_copilot_conversations_id_fk" FOREIGN KEY ("copilot_conversation_id") REFERENCES "public"."copilot_conversations"("id") ON DELETE set null ON UPDATE no action;