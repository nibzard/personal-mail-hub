ALTER TABLE "outbound_messages" ADD COLUMN "append_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "sent_copy_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "reconcile_attempts" integer DEFAULT 0 NOT NULL;