ALTER TABLE "messages" ADD COLUMN "thread_dirty" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_parent_message_id_idx" ON "messages" USING btree ("parent_message_id");--> statement-breakpoint
CREATE INDEX "messages_thread_dirty_idx" ON "messages" USING btree ("account_id","sent_at" desc) WHERE "thread_dirty";