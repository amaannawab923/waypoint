CREATE TABLE "auth_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" "auth_method" NOT NULL,
	"secret_hash" text NOT NULL,
	"email" text,
	"redirect_uri" text NOT NULL,
	"client_state" text NOT NULL,
	"purpose" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "auth_flows_secret_hash_unique" UNIQUE("secret_hash")
);
