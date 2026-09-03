ALTER TYPE "public"."network" RENAME TO "visibility";--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "network" TO "visibility";