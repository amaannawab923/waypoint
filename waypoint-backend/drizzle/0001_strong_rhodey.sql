CREATE TYPE "public"."copilot_message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TABLE "copilot_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copilot_conversations_member_id_unique" UNIQUE("member_id")
);
--> statement-breakpoint
CREATE TABLE "copilot_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" "copilot_message_role" NOT NULL,
	"content" text NOT NULL,
	"seq" bigserial NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copilot_conversations" ADD CONSTRAINT "copilot_conversations_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_messages" ADD CONSTRAINT "copilot_messages_conversation_id_copilot_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."copilot_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "copilot_messages_conversation_id_seq_idx" ON "copilot_messages" USING btree ("conversation_id","seq");