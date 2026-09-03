-- C3 of the vocabulary rename (docs/design/RENAME-STATE.md).
--
-- The rename half of this file is drizzle-kit's output, generated under a pty
-- so its rename-vs-drop prompts could be answered: every table and column
-- below is an ALTER ... RENAME, never a drop-and-recreate. The constraint
-- drop/re-add pairs are there because Postgres does not rename a constraint
-- when its table is renamed.
--
-- Three blocks are hand-written, because drizzle-kit cannot express them, and
-- two of those are destructive. They are marked HAND-WRITTEN below and are
-- explained in waypoint-revamp-architecture.md §3.2 (item 19), §3.3 and §3.5.

CREATE TYPE "public"."ticket_source" AS ENUM('manual', 'request', 'agent', 'import');--> statement-breakpoint
ALTER TYPE "public"."module_status" RENAME TO "workstream_status";--> statement-breakpoint
ALTER TYPE "public"."page_visibility" RENAME TO "doc_visibility";--> statement-breakpoint
ALTER TYPE "public"."intake_status" RENAME TO "request_status";--> statement-breakpoint
ALTER TABLE "cycle_members" RENAME TO "sprint_members";--> statement-breakpoint
ALTER TABLE "cycles" RENAME TO "sprints";--> statement-breakpoint
ALTER TABLE "module_members" RENAME TO "workstream_members";--> statement-breakpoint
ALTER TABLE "work_modules" RENAME TO "workstreams";--> statement-breakpoint
ALTER TABLE "pages" RENAME TO "docs";--> statement-breakpoint
ALTER TABLE "intake_requests" RENAME TO "requests";--> statement-breakpoint
ALTER TABLE "stickies" RENAME TO "scratch_notes";--> statement-breakpoint
ALTER TABLE "sprint_members" RENAME COLUMN "cycle_id" TO "sprint_id";--> statement-breakpoint
ALTER TABLE "workstream_members" RENAME COLUMN "module_id" TO "workstream_id";--> statement-breakpoint
ALTER TABLE "tickets" RENAME COLUMN "module_id" TO "workstream_id";--> statement-breakpoint
ALTER TABLE "tickets" RENAME COLUMN "cycle_id" TO "sprint_id";--> statement-breakpoint
ALTER TABLE "docs" RENAME COLUMN "parent_page_id" TO "parent_doc_id";--> statement-breakpoint
ALTER TABLE "sprint_members" DROP CONSTRAINT "cycle_members_cycle_id_cycles_id_fk";
--> statement-breakpoint
ALTER TABLE "sprint_members" DROP CONSTRAINT "cycle_members_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "sprints" DROP CONSTRAINT "cycles_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "sprints" DROP CONSTRAINT "cycles_lead_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "workstream_members" DROP CONSTRAINT "module_members_module_id_work_modules_id_fk";
--> statement-breakpoint
ALTER TABLE "workstream_members" DROP CONSTRAINT "module_members_member_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "workstreams" DROP CONSTRAINT "work_modules_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "workstreams" DROP CONSTRAINT "work_modules_lead_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_module_id_work_modules_id_fk";
--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_cycle_id_cycles_id_fk";
--> statement-breakpoint
ALTER TABLE "docs" DROP CONSTRAINT "pages_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "docs" DROP CONSTRAINT "pages_owner_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "docs" DROP CONSTRAINT "pages_parent_page_id_pages_id_fk";
--> statement-breakpoint
ALTER TABLE "requests" DROP CONSTRAINT "intake_requests_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "requests" DROP CONSTRAINT "intake_requests_linked_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE "scratch_notes" DROP CONSTRAINT "stickies_author_id_members_id_fk";
--> statement-breakpoint

-- ===========================================================================
-- HAND-WRITTEN 1 — dropping the 'triage' state group (architecture §3.3).
-- DESTRUCTIVE: which specific triage state a ticket sat in is not recoverable
-- after this runs. Step 1 preserves the one fact that mattered.
-- ===========================================================================

-- 1. The replacement, added before anything is removed. Provenance is a fact
--    about the ticket; it does not belong in the project's workflow column.
ALTER TABLE "tickets" ADD COLUMN "source" "ticket_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint

-- 2. Backfill provenance from the requests table while the link still exists.
UPDATE "tickets" t SET "source" = 'request'
  FROM "requests" r WHERE r."linked_ticket_id" = t."id";--> statement-breakpoint

-- 3. Move every ticket sitting in a triage state to its project's first
--    backlog state. tickets.state_id is ON DELETE RESTRICT, so this has to
--    happen before those states can go.
UPDATE "tickets" t
   SET "state_id" = (
     SELECT s2."id" FROM "ticket_states" s2
      WHERE s2."project_id" = t."project_id" AND s2."group" = 'backlog'
      ORDER BY s2."sort_order" LIMIT 1)
 WHERE t."state_id" IN (SELECT "id" FROM "ticket_states" WHERE "group" = 'triage');--> statement-breakpoint

DELETE FROM "ticket_states" WHERE "group" = 'triage';--> statement-breakpoint

-- 4. Rebuild state_group without 'triage'. Postgres has no
--    ALTER TYPE ... DROP VALUE, so this is the rename-recreate-swap dance.
ALTER TYPE "public"."state_group" RENAME TO "state_group_old";--> statement-breakpoint
CREATE TYPE "public"."state_group" AS ENUM('backlog', 'unstarted', 'started', 'completed', 'cancelled');--> statement-breakpoint
ALTER TABLE "ticket_states" ALTER COLUMN "group" SET DATA TYPE "public"."state_group"
  USING "group"::text::"public"."state_group";--> statement-breakpoint
DROP TYPE "public"."state_group_old";--> statement-breakpoint

-- 5. Triage held is_default in the seeded template, so a project can be left
--    with no default state. Give one back to any project that lost its only
--    one.
UPDATE "ticket_states" SET "is_default" = true
 WHERE "id" IN (SELECT DISTINCT ON ("project_id") "id" FROM "ticket_states"
                 WHERE "group" = 'backlog' ORDER BY "project_id", "sort_order")
   AND NOT EXISTS (SELECT 1 FROM "ticket_states" s2
                    WHERE s2."project_id" = "ticket_states"."project_id" AND s2."is_default");--> statement-breakpoint

-- ===========================================================================
-- HAND-WRITTEN 2 — workstream_status: six values to five (architecture §3.2
-- item 19). DESTRUCTIVE: 'backlog' and 'planned' both become 'planned', so
-- the distinction between them is gone and cannot be reconstructed.
-- ===========================================================================

ALTER TABLE "workstreams" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."workstream_status" RENAME TO "workstream_status_old";--> statement-breakpoint
CREATE TYPE "public"."workstream_status" AS ENUM('planned', 'active', 'paused', 'done', 'dropped');--> statement-breakpoint
ALTER TABLE "workstreams" ALTER COLUMN "status" SET DATA TYPE "public"."workstream_status"
  USING (
    CASE "status"::text
      WHEN 'backlog'     THEN 'planned'
      WHEN 'in-progress' THEN 'active'
      WHEN 'completed'   THEN 'done'
      WHEN 'cancelled'   THEN 'dropped'
      ELSE "status"::text
    END
  )::"public"."workstream_status";--> statement-breakpoint
ALTER TABLE "workstreams" ALTER COLUMN "status" SET DEFAULT 'planned'::"public"."workstream_status";--> statement-breakpoint
DROP TYPE "public"."workstream_status_old";--> statement-breakpoint

ALTER TABLE "sprint_members" DROP CONSTRAINT "cycle_members_cycle_id_member_id_pk";--> statement-breakpoint
ALTER TABLE "workstream_members" DROP CONSTRAINT "module_members_module_id_member_id_pk";--> statement-breakpoint
ALTER TABLE "sprint_members" ADD CONSTRAINT "sprint_members_sprint_id_member_id_pk" PRIMARY KEY("sprint_id","member_id");--> statement-breakpoint
ALTER TABLE "workstream_members" ADD CONSTRAINT "workstream_members_workstream_id_member_id_pk" PRIMARY KEY("workstream_id","member_id");--> statement-breakpoint
ALTER TABLE "sprint_members" ADD CONSTRAINT "sprint_members_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_members" ADD CONSTRAINT "sprint_members_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_lead_id_members_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstream_members" ADD CONSTRAINT "workstream_members_workstream_id_workstreams_id_fk" FOREIGN KEY ("workstream_id") REFERENCES "public"."workstreams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstream_members" ADD CONSTRAINT "workstream_members_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_lead_id_members_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_workstream_id_workstreams_id_fk" FOREIGN KEY ("workstream_id") REFERENCES "public"."workstreams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_owner_id_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_parent_doc_id_docs_id_fk" FOREIGN KEY ("parent_doc_id") REFERENCES "public"."docs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_linked_ticket_id_tickets_id_fk" FOREIGN KEY ("linked_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scratch_notes" ADD CONSTRAINT "scratch_notes_author_id_members_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ===========================================================================
-- HAND-WRITTEN 3 — data only. Stored values that spell the old vocabulary:
-- activity verbs (§3.2), webhook event types (§3.5), and the ProjectFeatures
-- jsonb keys, whose names are the primitives themselves.
-- ===========================================================================

UPDATE "activity_entries" SET "verb" = 'workstream_added' WHERE "verb" = 'module_added';--> statement-breakpoint
UPDATE "activity_entries" SET "verb" = 'sprint_added'     WHERE "verb" = 'cycle_added';--> statement-breakpoint
UPDATE "activity_entries" SET "verb" = 'subtask_added'    WHERE "verb" = 'sub_item_added';--> statement-breakpoint

-- COALESCE + WITH ORDINALITY: array_agg over an empty array returns NULL,
-- and event_types is NOT NULL; the ordinality keeps the picker's order.
UPDATE "webhooks" SET "event_types" = COALESCE((
  SELECT array_agg(
    CASE e
      WHEN 'work_item.created' THEN 'ticket.created'
      WHEN 'work_item.updated' THEN 'ticket.updated'
      WHEN 'work_item.deleted' THEN 'ticket.deleted'
      WHEN 'cycle.created'     THEN 'sprint.created'
      WHEN 'module.created'    THEN 'workstream.created'
      ELSE e END ORDER BY ord)
  FROM unnest("event_types") WITH ORDINALITY AS t(e, ord)
), ARRAY[]::text[]);--> statement-breakpoint

UPDATE "projects" SET "features" = jsonb_build_object(
  'sprints',     COALESCE(("features"->>'cycles')::boolean,  false),
  'workstreams', COALESCE(("features"->>'modules')::boolean, false),
  'views',       COALESCE(("features"->>'views')::boolean,   false),
  'docs',        COALESCE(("features"->>'pages')::boolean,   false),
  'requests',    COALESCE(("features"->>'intake')::boolean,  false)
) WHERE "features" ? 'cycles';
