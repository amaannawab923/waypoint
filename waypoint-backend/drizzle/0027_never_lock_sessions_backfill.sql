-- Never-lock (2026-09-20, round 2 of review): split out of 0026 — found in
-- review that reordering DROP INDEX to run after the backfill did NOT
-- shrink the ACCESS EXCLUSIVE window as the original comment claimed.
-- `drizzle-kit migrate` wraps an entire file in one transaction, and
-- Postgres never downgrades or releases a lock mid-transaction: 0026's own
-- `ALTER TABLE agent_runs ADD COLUMN` statements already take ACCESS
-- EXCLUSIVE on agent_runs, and that lock — acquired before the backfill —
-- was still held through the backfill's full-table UPDATE and all the way
-- to 0026's COMMIT, regardless of where DROP INDEX sat in the file.
--
-- The actual fix is this: a separate migration, a separate transaction.
-- This one opens with no lock on agent_runs at all, so the backfill UPDATE
-- runs first under only a plain row-exclusive lock (MVCC keeps readers
-- unaffected), and DROP INDEX — a catalog-only, effectively instant change
-- — only then takes ACCESS EXCLUSIVE, for its own statement alone.
UPDATE "agent_runs" SET "finalize_count" = 1 WHERE "entry" = 'dispatched' AND "status" IN ('needs-review','done');--> statement-breakpoint
DROP INDEX "agent_runs_one_live_writer_per_ticket";
