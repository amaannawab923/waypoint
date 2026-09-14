CREATE TABLE "instance_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_name" text DEFAULT 'Waypoint' NOT NULL,
	"signup_mode" text DEFAULT 'invite_only' NOT NULL,
	"setup_completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"device_label" text,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"auth_method" "auth_method" DEFAULT 'email' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"auth_provider_id" text,
	"full_name" text NOT NULL,
	"avatar_url" text,
	"is_instance_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "members" DROP CONSTRAINT "members_email_unique";--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "is_personal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "review_history_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_workspace_id_email_unique" UNIQUE("workspace_id","email");--> statement-breakpoint
UPDATE "workspaces" SET "is_personal" = true WHERE "id" = 'ws-1';
