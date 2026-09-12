CREATE TABLE "agent_run_transcripts" (
	"run_id" text PRIMARY KEY NOT NULL,
	"turns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_transcripts" ADD CONSTRAINT "agent_run_transcripts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;