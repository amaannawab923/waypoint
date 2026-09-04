ALTER TABLE "projects" ADD COLUMN "accepts_requests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "projects" SET "accepts_requests" = COALESCE(("features"->>'requests')::boolean, ("features"->>'intake')::boolean, false);--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "features";