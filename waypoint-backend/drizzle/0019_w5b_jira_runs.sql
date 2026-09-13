ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_ticket_id_shape" CHECK ("agent_runs"."ticket_id" IS NULL OR "agent_runs"."ticket_id" LIKE 'wi-%' OR "agent_runs"."ticket_id" LIKE 'tref-%');