CREATE TABLE "enrollment_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"recovery_generation" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "enrollment_grants_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "enrollment_grants_purpose_check" CHECK ("purpose" in ('bootstrap', 'recovery'))
);
--> statement-breakpoint
CREATE TABLE "owner" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_id_unique" UNIQUE("id"),
	CONSTRAINT "owner_singleton_check" CHECK ("singleton")
);
--> statement-breakpoint
CREATE TABLE "owner_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"label" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb,
	"device_type" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "owner_credentials_credential_id_unique" UNIQUE("credential_id"),
	CONSTRAINT "owner_credentials_device_type_check" CHECK ("device_type" is null or "device_type" in ('singleDevice', 'multiDevice'))
);
--> statement-breakpoint
CREATE TABLE "owner_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"recovery_generation" uuid NOT NULL,
	"kind" text DEFAULT 'standard' NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "owner_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "owner_sessions_kind_check" CHECK ("kind" in ('standard', 'inspection'))
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"owner_id" uuid,
	"challenge" text NOT NULL,
	"recovery_generation" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "webauthn_challenges_purpose_check" CHECK ("purpose" in ('first_enrollment', 'recovery_enrollment', 'add_credential', 'login', 'reverify')),
	CONSTRAINT "webauthn_challenges_owner_check" CHECK ("owner_id" is not null or "purpose" = 'first_enrollment')
);
--> statement-breakpoint
ALTER TABLE "owner_credentials" ADD CONSTRAINT "owner_credentials_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_sessions" ADD CONSTRAINT "owner_sessions_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enrollment_grants_live_purpose_uidx" ON "enrollment_grants" USING btree ("purpose") WHERE "consumed_at" is null and "revoked_at" is null;--> statement-breakpoint
CREATE INDEX "webauthn_challenges_challenge_idx" ON "webauthn_challenges" USING btree ("challenge");