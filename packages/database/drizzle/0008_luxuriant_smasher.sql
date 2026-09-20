DROP INDEX "events_type_entity_id_idx";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "body_failed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "events_type_entity_id_at_idx" ON "events" USING btree ("type","entity_id","at" desc);