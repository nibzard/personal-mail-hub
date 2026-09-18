CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"color" text NOT NULL,
	"imap_host" text DEFAULT 'imap.purelymail.com' NOT NULL,
	"imap_port" integer DEFAULT 993 NOT NULL,
	"imap_security" text DEFAULT 'implicit_tls' NOT NULL,
	"smtp_host" text DEFAULT 'smtp.purelymail.com' NOT NULL,
	"smtp_port" integer DEFAULT 587 NOT NULL,
	"smtp_security" text DEFAULT 'starttls_required' NOT NULL,
	"username" text NOT NULL,
	"password_enc" text NOT NULL,
	"identities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"classify_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_imap_security_check" CHECK ("imap_security" = 'implicit_tls'),
	CONSTRAINT "accounts_smtp_security_check" CHECK ("smtp_security" in ('starttls_required', 'implicit_tls'))
);
--> statement-breakpoint
CREATE TABLE "action_items" (
	"action_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"target" jsonb NOT NULL,
	"status" text NOT NULL,
	"outcome" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_items_action_id_item_key_pk" PRIMARY KEY("action_id","item_key")
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"recovery_generation" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"kind" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"part_path" text NOT NULL,
	"locator_version" smallint DEFAULT 1 NOT NULL,
	"decoded_sha256" text NOT NULL,
	"content_id" text,
	"disposition" text,
	"filename" text,
	"content_type" text,
	"size_bytes" bigint NOT NULL,
	"storage_key" text,
	"fetched_at" timestamp with time zone,
	CONSTRAINT "attachments_message_id_part_path_key" UNIQUE("message_id","part_path"),
	CONSTRAINT "attachments_locator_version_check" CHECK ("locator_version" > 0),
	CONSTRAINT "attachments_size_bytes_check" CHECK ("size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bodies" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"text_plain" text,
	"html_sanitized" text,
	"sanitizer_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_state" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"work_state" text,
	"snoozed_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"model" text NOT NULL,
	"question_set" text NOT NULL,
	"answers" jsonb NOT NULL,
	"confidence" jsonb,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_uploads" (
	"draft_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "draft_uploads_draft_id_upload_id_pk" PRIMARY KEY("draft_id","upload_id"),
	CONSTRAINT "draft_uploads_draft_id_ordinal_key" UNIQUE("draft_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"identity" jsonb NOT NULL,
	"thread_id" uuid,
	"reply_parent_id" uuid,
	"in_reply_to" text,
	"reference_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recipients" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subject" text,
	"markdown" text DEFAULT '' NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"locked_by_send" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"uidvalidity" bigint,
	"arrival_scanned_uid" bigint DEFAULT 0 NOT NULL,
	"backfill_upper_uid" bigint,
	"backfill_before_uid" bigint,
	"backfill_complete" boolean DEFAULT false NOT NULL,
	CONSTRAINT "folders_id_account_id_key" UNIQUE("id","account_id"),
	CONSTRAINT "folders_account_id_name_key" UNIQUE("account_id","name")
);
--> statement-breakpoint
CREATE TABLE "message_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"uidvalidity" bigint NOT NULL,
	"uid" bigint NOT NULL,
	"internal_date" timestamp with time zone NOT NULL,
	"unread" boolean DEFAULT true NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"modseq" numeric(20, 0),
	"revision" bigint DEFAULT 1 NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expunged_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "message_occurrences_folder_id_uidvalidity_uid_key" UNIQUE("folder_id","uidvalidity","uid")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" text,
	"in_reply_to" text,
	"reference_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thread_id" uuid,
	"parent_message_id" uuid,
	"thread_link_state" text DEFAULT 'pending' NOT NULL,
	"sender" jsonb,
	"reply_to" jsonb,
	"recipients" jsonb,
	"subject" text,
	"sent_at" timestamp with time zone,
	"snippet" text,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"size_bytes" bigint,
	"fetched_body" boolean DEFAULT false NOT NULL,
	"class_hint" text,
	"asks_action" boolean,
	"asks_reply" boolean,
	"time_sensitive" boolean,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"original_storage_key" text,
	"original_sha256" text,
	"sender_text" text DEFAULT '' NOT NULL,
	"recipients_text" text DEFAULT '' NOT NULL,
	"subject_text" text DEFAULT '' NOT NULL,
	"body_index_text" text DEFAULT '' NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', "sender_text"), 'A') ||
          setweight(to_tsvector('simple', "recipients_text"), 'A') ||
          setweight(to_tsvector('simple', "subject_text"), 'A') ||
          setweight(to_tsvector('simple', "body_index_text"), 'B')) STORED,
	CONSTRAINT "messages_id_account_id_key" UNIQUE("id","account_id"),
	CONSTRAINT "messages_parent_message_id_check" CHECK ("parent_message_id" <> "id"),
	CONSTRAINT "messages_thread_link_state_check" CHECK ("thread_link_state" in ('root', 'pending', 'linked', 'ambiguous')),
	CONSTRAINT "messages_thread_link_state_parent_check" CHECK (("thread_link_state" = 'linked') = ("parent_message_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"recovery_generation" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"draft_id" uuid,
	"draft_revision" bigint NOT NULL,
	"identity" jsonb NOT NULL,
	"envelope_sender" text NOT NULL,
	"envelope_recipients" jsonb NOT NULL,
	"status" text NOT NULL,
	"logical_message_id" uuid,
	"thread_id" uuid,
	"reply_parent_id" uuid,
	"in_reply_to" text,
	"reference_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recipients" jsonb NOT NULL,
	"subject" text,
	"markdown_source" text NOT NULL,
	"html" text,
	"rfc_message_id" text NOT NULL,
	"mime_storage_key" text NOT NULL,
	"mime_sha256" text NOT NULL,
	"smtp_response" jsonb,
	"recipient_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sending_started_at" timestamp with time zone,
	"sent_copy_status" text DEFAULT 'pending' NOT NULL,
	"sent_folder_id" uuid,
	"sent_uidvalidity" bigint,
	"sent_uid" bigint,
	"last_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "outbound_messages_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "outbound_messages_logical_message_id_unique" UNIQUE("logical_message_id"),
	CONSTRAINT "outbound_messages_rfc_message_id_unique" UNIQUE("rfc_message_id"),
	CONSTRAINT "outbound_messages_status_check" CHECK ("status" in ('queued', 'sending', 'sent', 'failed', 'outcome_unknown')),
	CONSTRAINT "outbound_messages_sent_copy_status_check" CHECK ("sent_copy_status" in ('pending', 'appending', 'stored', 'failed', 'unknown')),
	CONSTRAINT "outbound_messages_sent_requires_message_check" CHECK ("status" <> 'sent' or "logical_message_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "outbound_uploads" (
	"outbound_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "outbound_uploads_outbound_id_upload_id_pk" PRIMARY KEY("outbound_id","upload_id"),
	CONSTRAINT "outbound_uploads_outbound_id_ordinal_key" UNIQUE("outbound_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "sender_overrides" (
	"account_id" uuid NOT NULL,
	"sender" text NOT NULL,
	"class_hint" text,
	"note" text,
	CONSTRAINT "sender_overrides_account_id_sender_pk" PRIMARY KEY("account_id","sender")
);
--> statement-breakpoint
CREATE TABLE "service_state" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"recovery_generation" uuid NOT NULL,
	"recovery_mode" text DEFAULT 'ready' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_state_singleton_check" CHECK ("singleton"),
	CONSTRAINT "service_state_recovery_mode_check" CHECK ("recovery_mode" in ('ready', 'reconciling'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"subject_norm" text,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_id_account_id_key" UNIQUE("id","account_id")
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uploads_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bodies" ADD CONSTRAINT "bodies_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_uploads" ADD CONSTRAINT "draft_uploads_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_uploads" ADD CONSTRAINT "draft_uploads_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_thread_id_account_id_threads_id_account_id_fk" FOREIGN KEY ("thread_id","account_id") REFERENCES "public"."threads"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_reply_parent_id_account_id_messages_id_account_id_fk" FOREIGN KEY ("reply_parent_id","account_id") REFERENCES "public"."messages"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_locked_by_send_outbound_messages_id_fk" FOREIGN KEY ("locked_by_send") REFERENCES "public"."outbound_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_occurrences" ADD CONSTRAINT "message_occurrences_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_occurrences" ADD CONSTRAINT "message_occurrences_message_id_account_id_messages_id_account_id_fk" FOREIGN KEY ("message_id","account_id") REFERENCES "public"."messages"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_occurrences" ADD CONSTRAINT "message_occurrences_folder_id_account_id_folders_id_account_id_fk" FOREIGN KEY ("folder_id","account_id") REFERENCES "public"."folders"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_account_id_threads_id_account_id_fk" FOREIGN KEY ("thread_id","account_id") REFERENCES "public"."threads"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_message_id_account_id_messages_id_account_id_fk" FOREIGN KEY ("parent_message_id","account_id") REFERENCES "public"."messages"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_sent_folder_id_folders_id_fk" FOREIGN KEY ("sent_folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_thread_id_account_id_threads_id_account_id_fk" FOREIGN KEY ("thread_id","account_id") REFERENCES "public"."threads"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_logical_message_id_account_id_messages_id_account_id_fk" FOREIGN KEY ("logical_message_id","account_id") REFERENCES "public"."messages"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_reply_parent_id_account_id_messages_id_account_id_fk" FOREIGN KEY ("reply_parent_id","account_id") REFERENCES "public"."messages"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_uploads" ADD CONSTRAINT "outbound_uploads_outbound_id_outbound_messages_id_fk" FOREIGN KEY ("outbound_id") REFERENCES "public"."outbound_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_uploads" ADD CONSTRAINT "outbound_uploads_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_overrides" ADD CONSTRAINT "sender_overrides_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_account_id_role_uidx" ON "folders" USING btree ("account_id","role") WHERE "role" is not null;--> statement-breakpoint
CREATE INDEX "message_occurrences_message_id_idx" ON "message_occurrences" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_occurrences_active_folder_uid_idx" ON "message_occurrences" USING btree ("folder_id","uid") WHERE "expunged_at" is null and "invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "messages_thread_id_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "messages_account_id_sent_at_idx" ON "messages" USING btree ("account_id","sent_at" desc);--> statement-breakpoint
CREATE INDEX "messages_message_id_idx" ON "messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "messages_account_id_in_reply_to_idx" ON "messages" USING btree ("account_id","in_reply_to");--> statement-breakpoint
CREATE INDEX "messages_reference_ids_idx" ON "messages" USING gin ("reference_ids");--> statement-breakpoint
CREATE INDEX "messages_class_hint_idx" ON "messages" USING btree ("class_hint") WHERE "class_hint" is not null;--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "messages" USING gin ("search");--> statement-breakpoint
CREATE INDEX "messages_sender_text_trgm_idx" ON "messages" USING gin ("sender_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "messages_subject_text_trgm_idx" ON "messages" USING gin ("subject_text" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_account_id_original_sha256_uidx" ON "messages" USING btree ("account_id","original_sha256") WHERE "original_sha256" is not null;