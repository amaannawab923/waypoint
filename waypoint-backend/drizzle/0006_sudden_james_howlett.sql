ALTER TABLE "work_item_states" RENAME TO "ticket_states";--> statement-breakpoint
ALTER TABLE "work_item_assignees" RENAME TO "ticket_assignees";--> statement-breakpoint
ALTER TABLE "work_item_labels" RENAME TO "ticket_labels";--> statement-breakpoint
ALTER TABLE "work_item_links" RENAME TO "ticket_links";--> statement-breakpoint
ALTER TABLE "work_items" RENAME TO "tickets";--> statement-breakpoint
ALTER TABLE "activity_entries" RENAME COLUMN "work_item_id" TO "ticket_id";--> statement-breakpoint
ALTER TABLE "comments" RENAME COLUMN "work_item_id" TO "ticket_id";--> statement-breakpoint
ALTER TABLE "ticket_assignees" RENAME COLUMN "work_item_id" TO "ticket_id";--> statement-breakpoint
ALTER TABLE "ticket_labels" RENAME COLUMN "work_item_id" TO "ticket_id";--> statement-breakpoint
ALTER TABLE "ticket_links" RENAME COLUMN "work_item_id" TO "ticket_id";--> statement-breakpoint
ALTER TABLE "intake_requests" RENAME COLUMN "linked_work_item_id" TO "linked_ticket_id";--> statement-breakpoint
ALTER TABLE "notifications" RENAME COLUMN "work_item_id" TO "ticket_id";--> statement-breakpoint
ALTER TABLE "agent_assignments" RENAME COLUMN "work_item_id" TO "ticket_id";--> statement-breakpoint
ALTER TABLE "copilot_proposals" RENAME COLUMN "work_item_id" TO "ticket_id";--> statement-breakpoint
ALTER TABLE "ticket_assignees" DROP CONSTRAINT "work_item_assignees_work_item_id_assignee_id_unique";--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "work_items_identifier_unique";--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "work_items_project_id_sequence_id_unique";--> statement-breakpoint
ALTER TABLE "agent_assignments" DROP CONSTRAINT "agent_assignments_work_item_id_agent_id_unique";--> statement-breakpoint
ALTER TABLE "ticket_states" DROP CONSTRAINT "work_item_states_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "activity_entries" DROP CONSTRAINT "activity_entries_work_item_id_work_items_id_fk";
--> statement-breakpoint
ALTER TABLE "comments" DROP CONSTRAINT "comments_work_item_id_work_items_id_fk";
--> statement-breakpoint
ALTER TABLE "ticket_assignees" DROP CONSTRAINT "work_item_assignees_work_item_id_work_items_id_fk";
--> statement-breakpoint
ALTER TABLE "ticket_labels" DROP CONSTRAINT "work_item_labels_work_item_id_work_items_id_fk";
--> statement-breakpoint
ALTER TABLE "ticket_labels" DROP CONSTRAINT "work_item_labels_label_id_labels_id_fk";
--> statement-breakpoint
ALTER TABLE "ticket_links" DROP CONSTRAINT "work_item_links_work_item_id_work_items_id_fk";
--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "work_items_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "work_items_state_id_work_item_states_id_fk";
--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "work_items_module_id_work_modules_id_fk";
--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "work_items_cycle_id_cycles_id_fk";
--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "work_items_parent_id_work_items_id_fk";
--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "work_items_created_by_id_members_id_fk";
--> statement-breakpoint
ALTER TABLE "intake_requests" DROP CONSTRAINT "intake_requests_linked_work_item_id_work_items_id_fk";
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_work_item_id_work_items_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_assignments" DROP CONSTRAINT "agent_assignments_work_item_id_work_items_id_fk";
--> statement-breakpoint
ALTER TABLE "ticket_labels" DROP CONSTRAINT "work_item_labels_work_item_id_label_id_pk";--> statement-breakpoint
ALTER TABLE "ticket_labels" ADD CONSTRAINT "ticket_labels_ticket_id_label_id_pk" PRIMARY KEY("ticket_id","label_id");--> statement-breakpoint
ALTER TABLE "ticket_states" ADD CONSTRAINT "ticket_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_entries" ADD CONSTRAINT "activity_entries_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_assignees" ADD CONSTRAINT "ticket_assignees_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_labels" ADD CONSTRAINT "ticket_labels_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_labels" ADD CONSTRAINT "ticket_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_state_id_ticket_states_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."ticket_states"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_module_id_work_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."work_modules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_parent_id_tickets_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_created_by_id_members_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_requests" ADD CONSTRAINT "intake_requests_linked_ticket_id_tickets_id_fk" FOREIGN KEY ("linked_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_assignments" ADD CONSTRAINT "agent_assignments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_assignees" ADD CONSTRAINT "ticket_assignees_ticket_id_assignee_id_unique" UNIQUE("ticket_id","assignee_id");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_identifier_unique" UNIQUE("identifier");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_sequence_id_unique" UNIQUE("project_id","sequence_id");--> statement-breakpoint
ALTER TABLE "agent_assignments" ADD CONSTRAINT "agent_assignments_ticket_id_agent_id_unique" UNIQUE("ticket_id","agent_id");