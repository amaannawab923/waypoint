ALTER TABLE "scratch_notes" ADD COLUMN "workspace_id" text;--> statement-breakpoint
UPDATE "scratch_notes" SET "workspace_id" = 'ws-1' WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "scratch_notes" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scratch_notes" ADD CONSTRAINT "scratch_notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
