CREATE TYPE "public"."proposal_decided_by" AS ENUM('user', 'trust_grant', 'system');--> statement-breakpoint
CREATE TYPE "public"."proposal_origin" AS ENUM('copilot', 'agent_run');--> statement-breakpoint
ALTER TYPE "public"."proposal_kind" ADD VALUE 'add_label';--> statement-breakpoint
ALTER TYPE "public"."proposal_status" ADD VALUE 'reverted';--> statement-breakpoint
DROP INDEX "copilot_proposals_conversation_id_created_at_idx";--> statement-breakpoint
ALTER TABLE "proposals" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ALTER COLUMN "anchor_seq" DROP NOT NULL;--> statement-breakpoint
-- origin and project_id land NOT NULL in the final schema, but this table
-- already has rows (every existing proposal predates this migration and is
-- origin='copilot' with, for every kind but create_ticket, a resolvable
-- project via its ticket). Postgres can't add a bare NOT NULL column to a
-- non-empty table, so both land nullable here, get backfilled below, then
-- get the NOT NULL constraint applied once every row satisfies it.
ALTER TABLE "proposals" ADD COLUMN "origin" "proposal_origin";--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "agent_run_id" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "source_request_id" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "decided_by" "proposal_decided_by";--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "trust_grant_id" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "decision_latency_ms" integer;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_source_request_id_requests_id_fk" FOREIGN KEY ("source_request_id") REFERENCES "public"."requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill (architecture §4.2's migration note): every row that predates
-- this migration was written by the Copilot conversation flow.
UPDATE "proposals" SET "origin" = 'copilot' WHERE "origin" IS NULL;--> statement-breakpoint
-- Backfill project_id, case 1: every kind but create_ticket carries a
-- ticket_id — derive project_id by joining through it to tickets.
UPDATE "proposals" AS p SET "project_id" = t."project_id"
  FROM "tickets" AS t
  WHERE p."project_id" IS NULL AND p."ticket_id" = t."id";--> statement-breakpoint
-- Backfill project_id, case 2: create_ticket proposals have no ticket_id
-- yet (the ticket doesn't exist until the proposal is approved) — their
-- payload jsonb already carries the target project as "projectId" (see
-- CreateTicketProposalPayload / executeProposal's create_ticket case in
-- proposals.service.ts), so derive it from there instead.
UPDATE "proposals" SET "project_id" = "payload"->>'projectId'
  WHERE "project_id" IS NULL AND "ticket_id" IS NULL;--> statement-breakpoint
-- If any row is STILL unresolved here, the next statement fails with a
-- NOT NULL violation on project_id — deliberately: the only way to reach
-- this state is a ticket_id pointing at a ticket that has since been
-- HARD-deleted (ticket_id is intentionally not an FK — see the original
-- comment on copilot_proposals — so a proposal survives its ticket's
-- deletion and can be reported STALE rather than vanishing via a cascade).
-- Once the ticket is gone there is no remaining source of truth for which
-- project the row belonged to anywhere in this schema, so inventing one
-- would be exactly the placeholder this migration must not paper over
-- with. Surface the failure and resolve the specific row(s) by hand
-- (confirm none exist before running against a real database, or decide
-- explicitly — e.g. reassign, or accept the historical row's loss — rather
-- than let a migration decide unilaterally) rather than let this ALTER
-- silently coerce anything.
ALTER TABLE "proposals" ALTER COLUMN "origin" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "proposals_status_created_at_idx" ON "proposals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "proposals_project_status_idx" ON "proposals" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "proposals_agent_status_idx" ON "proposals" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "proposals_ticket_status_idx" ON "proposals" USING btree ("ticket_id","status");--> statement-breakpoint
CREATE INDEX "proposals_conversation_created_at_idx" ON "proposals" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "proposals_agent_kind_resolved_idx" ON "proposals" USING btree ("agent_id","kind","resolved_at");--> statement-breakpoint
CREATE INDEX "proposals_pending_expiry_idx" ON "proposals" USING btree ("expires_at") WHERE "proposals"."status" = 'proposed';--> statement-breakpoint
CREATE INDEX "proposals_stuck_claim_idx" ON "proposals" USING btree ("resolved_at") WHERE "proposals"."status" = 'executing';
