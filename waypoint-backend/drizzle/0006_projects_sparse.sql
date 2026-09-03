ALTER TABLE "projects" ADD COLUMN "accepts_requests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "features";