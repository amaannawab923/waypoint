CREATE TYPE "public"."agent_run_entry" AS ENUM('independent', 'dispatched');--> statement-breakpoint
CREATE TABLE "agent_run_events" (
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"ticket_id" text,
	"owner_member_id" text NOT NULL,
	"agent_id" text,
	"entry" "agent_run_entry" NOT NULL,
	"provider_id" text NOT NULL,
	"daemon_workspace_id" text,
	"daemon_session_id" text,
	"worktree_path" text,
	"branch" text,
	"base_ref" text,
	"pr_url" text,
	"status" "agent_run_status" DEFAULT 'queued' NOT NULL,
	"blocked_reason" text,
	"error_kind" text,
	"error_message" text,
	"summary" text,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"retry_of_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_assignments" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "agent_assignments" ALTER COLUMN "status" SET DEFAULT 'queued'::text;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "status" SET DEFAULT 'queued'::text;--> statement-breakpoint
DROP TYPE "public"."agent_run_status";--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'provisioning', 'running', 'blocked', 'finishing', 'needs-review', 'done', 'interrupted', 'failed', 'cancelled');--> statement-breakpoint
ALTER TABLE "agent_assignments" ALTER COLUMN "status" SET DEFAULT 'queued'::"public"."agent_run_status";--> statement-breakpoint
ALTER TABLE "agent_assignments" ALTER COLUMN "status" SET DATA TYPE "public"."agent_run_status" USING "status"::"public"."agent_run_status";--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "status" SET DEFAULT 'queued'::"public"."agent_run_status";--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "status" SET DATA TYPE "public"."agent_run_status" USING "status"::"public"."agent_run_status";--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_retry_of_run_id_agent_runs_id_fk" FOREIGN KEY ("retry_of_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_owner_created_idx" ON "agent_runs" USING btree ("owner_member_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_project_created_idx" ON "agent_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_ticket_idx" ON "agent_runs" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "agent_runs_status_idx" ON "agent_runs" USING btree ("status");--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;