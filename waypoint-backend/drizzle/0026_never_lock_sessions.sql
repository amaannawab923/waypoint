CREATE TABLE "agent_run_pending_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"by_member_id" text NOT NULL,
	"text" text NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"auto_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"claimed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "agent_runs_one_live_writer_per_ticket";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "finalize_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "finalized_head_sha" text;--> statement-breakpoint
ALTER TABLE "agent_run_pending_prompts" ADD CONSTRAINT "agent_run_pending_prompts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_pending_prompts" ADD CONSTRAINT "agent_run_pending_prompts_by_member_id_members_id_fk" FOREIGN KEY ("by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_pending_prompts_run_idx" ON "agent_run_pending_prompts" USING btree ("run_id","seq");--> statement-breakpoint
UPDATE "agent_runs" SET "finalize_count" = 1 WHERE "entry" = 'dispatched' AND "status" IN ('needs-review','done');
