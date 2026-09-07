CREATE TABLE "integration_credentials" (
	"provider" text PRIMARY KEY NOT NULL,
	"site" text NOT NULL,
	"email" text NOT NULL,
	"sealed_token" text NOT NULL,
	"account_id" text,
	"display_name" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_refs" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"external_site" text,
	"cached_identifier" text NOT NULL,
	"cached_title" text NOT NULL,
	"cached_url" text,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ticket_refs_provider_site_external_idx" UNIQUE("provider","external_site","external_id")
);
--> statement-breakpoint
CREATE INDEX "ticket_refs_provider_site_identifier_idx" ON "ticket_refs" USING btree ("provider","external_site","cached_identifier");