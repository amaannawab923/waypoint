-- Copilot/Jira write pass: a proposal targeting an external ("tref-") issue
-- has no Waypoint project to name. createProposal resolves project_id from
-- the target ticket's own project, and a Jira id matches no row in
-- `tickets`, so the correlated subquery correctly yields NULL — which the
-- NOT NULL constraint then rejected, failing every Copilot proposal against
-- a Jira ticket at insert time (Postgres 23502). The column stays (it is
-- what makes the Review queue's project filter one index scan for native
-- proposals) but is no longer required: a Jira issue belongs to a Jira
-- project, which is not a row in `projects`.

-- No backfill: every existing row predates Jira-targeted proposals and
-- already carries a real, non-null project id, so this widening is purely
-- additive and cannot orphan an existing row.
ALTER TABLE "proposals" ALTER COLUMN "project_id" DROP NOT NULL;
