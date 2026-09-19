# Personal mail hub development

## Modules

- `apps/web` contains the React client.
- `apps/api` contains HTTP routes and application services.
- `apps/worker` contains background job entry points.
- `apps/admin` contains the operator command line (`npm run admin -- ...`).
- `packages/contracts` contains shared API contracts.
- `packages/auth` contains passkey authentication: enrollment grants,
  WebAuthn ceremonies, owner sessions, and the `auth` admin commands.
- `packages/accounts` contains account and identity management: the
  AES-256-GCM credential cipher, folder discovery imports, role mapping,
  and send identities.
- `packages/recovery` contains the recovery control state, the mutation
  generation gate, and the operator recovery commands.
- `packages/transport` contains the verified IMAP and SMTP connection tests.
  Both protocols require validated TLS; credentials are only sent after the
  encrypted connection is verified.
- `packages/compose` contains draft editing and durable uploads: the
  revision-aware draft service with identity selection against configured
  account identities, uploads that persist in durable storage before the
  database acknowledges them, attachment verification against recorded
  hashes, the draft lock a queued send takes and only a definitive failure
  releases, and the client-side autosave state machine that debounces,
  coalesces edits, and surfaces stale-revision choices.
- `packages/ingestion` contains durable MIME ingestion: original-byte storage
  before processing, header and body parsing, HTML sanitizing, index text,
  verified attachment locators with hash-checked regeneration, and the
  thread-job marks that identity changes leave for reconciliation.
- `packages/sync` contains the IMAP synchronization engine: resumable
  backfill in checkpointed UID windows newest first, background body
  fetching, steady-state polls with arrival bounds, flag refreshes, and
  expunge detection, folder-generation resets, nightly inventory
  reconciliation, logical-message merging with parent linking and thread
  reconciliation, and one bounded cycle per account per cron run. The
  ImapFlow session also carries the two-way writes the action executor
  drives: conditional `UNCHANGEDSINCE` flag stores on a session opened with
  `condstoreWrites`, and IMAP `MOVE` with no expunge fallback.
- `packages/actions` contains the recovery-aware mail action service: frozen
  action records with per-target work items and idempotency keys, remote-state
  refresh with generation and revision checks before any write, per-item
  receipts, restart reconciliation, and the restore disposition behind
  `recovery hold-actions`. The two-way executor applies explicit flag values
  and moves over the writable mailbox port, reads every write back, and
  reports conflicts and unknown outcomes instead of guessing.
- `packages/database` contains the Drizzle schema, SQL migrations, object
  storage, and pg-boss integration. Run `npm run db:generate` there after
  changing `src/schema.ts`; apply migrations with `npm run db:migrate`.

## Commands

1. Run `npm install` after you change dependencies.
2. Run `npm run check` before you commit TypeScript changes.
3. Run `npm test` before you commit behavior changes.
4. Run `npm run db:migrate` with `DATABASE_URL` set to apply migrations. The
   migration test suite needs `TEST_DATABASE_URL` and skips without it.
5. Run `npm run admin -- recovery status` to inspect the recovery control
   state. Use `recovery init` on a fresh installation and `recovery begin`
   plus `recovery complete` after a restore. Run `recovery hold-actions`
   during recovery to disposition the actions a restore left behind.
6. Run `npm run admin -- auth bootstrap` on a fresh installation to print the
   first-passkey enrollment token, and `npm run admin -- auth recover` after
   all passkeys are lost. Set `BASE_URL` to the deployed origin first; the
   token prints once and only its hash is stored.

## Rules

- Keep mailbox credentials out of browser code and logs.
- Keep enrollment tokens and session tokens out of logs and URLs; store only
  their hashes.
- Validate every HTTP input at the API boundary.
- Use application services for mutations. Do not let routes or workers bypass them.
- Keep the provider mailbox state, application work state, and agent state separate.
- Check the recovery generation before the idempotency lookup in every
  mutation service. Reject an old generation with `409 recovery_required`.
- Workers stay blocked unless the deployment and database recovery state
  match with mode `ready`. A job keeps the generation it was created with;
  a lease renewal or queue retry never upgrades it.
