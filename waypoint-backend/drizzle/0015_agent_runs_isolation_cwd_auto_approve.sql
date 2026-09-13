ALTER TABLE "agent_runs" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "isolation" text DEFAULT 'worktree' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cwd" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "auto_approve" boolean DEFAULT false NOT NULL;