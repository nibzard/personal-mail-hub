CREATE TABLE "home_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "home_dismissals_account_id_message_id_key" UNIQUE("account_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "home_priorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"sender" text,
	"thread_id" uuid,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "home_priorities_target_shape_check" CHECK (("target_kind" = 'sender' and "sender" is not null and "thread_id" is null)
          or ("target_kind" = 'thread' and "thread_id" is not null and "sender" is null))
);
--> statement-breakpoint
CREATE TABLE "home_visits" (
	"device_id" text PRIMARY KEY NOT NULL,
	"boundary" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "home_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"anchor_message_id" uuid NOT NULL,
	"thread_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone,
	"time_zone" text,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "home_work_kind_check" CHECK ("kind" in ('reply_later', 'reminder')),
	CONSTRAINT "home_work_status_check" CHECK ("status" in ('open', 'done')),
	CONSTRAINT "home_work_reminder_due_check" CHECK (("kind" = 'reminder' and "due_at" is not null and "time_zone" is not null)
          or ("kind" = 'reply_later' and "due_at" is null and "time_zone" is null)),
	CONSTRAINT "home_work_completed_shape_check" CHECK (("status" = 'done') = ("completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "ingested_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "home_dismissals" ADD CONSTRAINT "home_dismissals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_priorities" ADD CONSTRAINT "home_priorities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_work" ADD CONSTRAINT "home_work_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "home_dismissals_message_id_idx" ON "home_dismissals" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "home_priorities_target_uidx" ON "home_priorities" USING btree ("account_id","target_kind",coalesce("sender", ''),coalesce("thread_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE UNIQUE INDEX "home_work_open_uidx" ON "home_work" USING btree ("account_id","kind","anchor_message_id") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX "home_work_due_idx" ON "home_work" USING btree ("due_at") WHERE "status" = 'open' and "kind" = 'reminder';--> statement-breakpoint
CREATE INDEX "home_work_anchor_idx" ON "home_work" USING btree ("anchor_message_id");--> statement-breakpoint
CREATE INDEX "home_work_done_idx" ON "home_work" USING btree ("completed_at" desc) WHERE "status" = 'done';--> statement-breakpoint
CREATE INDEX "messages_ingested_at_idx" ON "messages" USING btree ("ingested_at");