-- W3.5 (docs/design/waypoint-revamp-architecture.md §4.6): saved_views.filters
-- becomes a versioned, typed shape (ticketFilterSchema) and project scope
-- moves from the project_id column into filters.projectIds. Every existing
-- row today is confirmed empty jsonb ('{}') — ProjectViewsPage.tsx:239 was
-- the only call site that ever wrote filters, and it always wrote {} — so
-- both backfills below are total (no row is left in a shape neither UPDATE
-- recognizes) and lossless (an empty filter under the new schema still
-- means "no filters applied", same as {} meant before).

-- 1) Bring every existing (empty) filters value up to the versioned shape.
UPDATE "saved_views" SET "filters" = '{"v":1}'::jsonb WHERE "filters" = '{}'::jsonb;--> statement-breakpoint

-- 2) Denormalized project scope moves into the filter itself, for every
-- row (not just the ones touched above) — a view's project_id at
-- migration time is still the authoritative "what project was this view
-- scoped to" answer, so it's carried forward into filters.projectIds
-- before the column stops being required.
UPDATE "saved_views" SET "filters" = jsonb_set("filters", '{projectIds}', to_jsonb(ARRAY["project_id"])) WHERE "project_id" IS NOT NULL;--> statement-breakpoint

-- 3) project_id is kept (a view whose filter names exactly one project can
-- still denormalize it here for listing/indexing) but is no longer
-- required — a view's scope now lives in filters.projectIds, which can
-- name zero, one, or several projects.
ALTER TABLE "saved_views" ALTER COLUMN "project_id" DROP NOT NULL;
