ALTER TABLE "messages" ADD COLUMN "addresses_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_addresses_text_trgm_idx" ON "messages" USING gin ("addresses_text" gin_trgm_ops);--> statement-breakpoint
UPDATE "messages" SET "addresses_text" = concat_ws(' ',
  lower("sender"->>'address'),
  coalesce((
    SELECT string_agg(lower(entry->>'address'), ' ')
    FROM jsonb_array_elements(
      coalesce("recipients"->'to', '[]'::jsonb) ||
      coalesce("recipients"->'cc', '[]'::jsonb) ||
      coalesce("recipients"->'bcc', '[]'::jsonb)
    ) AS entry
  ), '')
);