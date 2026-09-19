# Personal mail hub development

## Modules

- `apps/web` contains the React client.
- `apps/api` contains HTTP routes and application services.
- `apps/worker` contains background job entry points.
- `apps/admin` contains the operator command line (`npm run admin -- ...`).
- `deploy` contains the deployment and backup procedures: the multi-stage
  Dockerfile targets (`app`, `web`), the container entrypoint with its
  environment preflight, the nginx gateway that serves the client and
  forwards `/api` to the API, the compose stack, and the backup, verify, and
  restore scripts. `deploy/README.md` documents the Coolify setup, the
  environment reference, the backup schedule, and the restore runbook.
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
- `packages/compose` contains draft editing, durable uploads, and reply
  addressing: the revision-aware draft service with identity selection
  against configured account identities, uploads that persist in durable
  storage before the database acknowledges them, attachment verification
  against recorded hashes, the draft lock a queued send takes and only a
  definitive failure releases, reply drafts derived from one selected parent
  with recipient lists that drop duplicates, configured identities, and Bcc
  copies, the explicit account and identity choices that grouped copies,
  ambiguous aliases, and malformed `Reply-To` headers require, and the
  `In-Reply-To` and `References` chain frozen onto the draft, plus the
  client-side autosave state machine that debounces, coalesces edits, and
  surfaces stale-revision choices.
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
  `condstoreWrites`, and IMAP `MOVE` with no expunge fallback. It also
  serves the Sent-copy job of the outbound pipeline: message appends of
  exact stored bytes and header searches that locate a copy for
  verification.
- `packages/actions` contains the recovery-aware mail action service: frozen
  action records with per-target work items and idempotency keys, remote-state
  refresh with generation and revision checks before any write, per-item
  receipts, restart reconciliation, and the restore disposition behind
  `recovery hold-actions`. The two-way executor applies explicit flag values
  and moves over the writable mailbox port, reads every write back, and
  reports conflicts and unknown outcomes instead of guessing.
- `packages/send` contains the outbound pipeline: immutable send snapshots
  frozen from drafts into exact MIME bytes, durable storage of those bytes
  with their hash, an atomic queued-to-sending claim that submits each
  snapshot exactly once over the verified SMTP port, recipient-level result
  recording with conservative outcome classification, local sent records
  keyed by account and original hash, and the draft lock that only a
  definitive refusal releases. A separate Sent-copy job appends the stored
  bytes to the Sent folder after acceptance: it verifies by generated
  identifier and hash before it appends, keeps uncertain appends unknown
  until reconciliation proves absence, and never invokes SMTP. Startup
  recovery holds abandoned `sending` and `appending` rows as unknown, and an
  unknown send resolves only from a verified Sent copy, in the same
  acceptance transaction. No path resubmits an uncertain attempt. The worker
  sweeps queued rows and Sent copies on cron queues; the API only queues.
- `packages/search` contains the cross-account search service: the query
  language with its operators, parsed by the same normalization ingestion
  applies to index text, weighted ranking and highlights over the generated
  search vector, account, domain, folder, and local-archive filters, the
  effective send date that falls back to the earliest server internal date,
  body-indexing progress, and saved searches that store query state behind
  the recovery generation gate.
- `packages/offline` contains the PWA's offline data and replay controls:
  the Dexie store for recent mail, local drafts, upload bytes, and the
  queued-action freezer, plus the replay controller that stamps every record
  with the recovery generation the server issued, replays the queue oldest
  first, stops on a generation change after a restore, and resolves the
  review that follows only through explicit choices — a resend needs the
  acknowledged duplicate warning and a new idempotency key, and a draft
  rebase needs the comparison with the server copy.
- `packages/reading` contains the safe message reader service: message
  detail over sanitized derivatives only, the inline-image decision that
  resolves a `cid:` reference only for a unique image Content-ID inside the
  same message, and attachment downloads that serve the disposable cache
  only after its decoded hash and size verify, else regenerate from the
  verified original without changing the attachment id.
- `packages/observability` contains the health report behind
  `GET /healthz`: one database round trip, the recovery control state, sync
  lag and the per-account metrics (messages synced, bodies fetched, last
  full reconciliation, Jev calls and errors), queue age over the job queue
  and the durable pending work, the classification circuit, and the send
  counters the weekly review watches. Every number is read from durable
  records; the report never writes. The audit trail itself lives in the
  `events` table, where the sync, action, send, account, authentication,
  and recovery services already record their milestones; classification
  corrections and pauses join them with the Jev integration.
- `packages/database` contains the Drizzle schema, SQL migrations, object
  storage, and pg-boss integration, plus the retrying scratch-database cleanup
  (`dropTestDatabase`) the PostgreSQL suites share. Run `npm run db:generate`
  there after changing `src/schema.ts`; apply migrations with
  `npm run db:migrate`.

## Commands

1. Run `npm install` after you change dependencies.
2. Run `npm run check` before you commit TypeScript changes.
3. Run `npm test` before you commit behavior changes.
4. Run `npm run db:migrate` with `DATABASE_URL` set to apply migrations. The
   migration test suite needs `TEST_DATABASE_URL` and skips without it.
5. Run `npm run release:gate` with `TEST_DATABASE_URL` set before a release.
   The gate runs the workspace type checks, applies every migration to a
   scratch database through the deployment path, runs the full test suite and
   the action-permission suites, and fails when any suite skips. Browser and
   interface checks defer until `apps/web` grows their runners; add a
   `test:e2e` and a `test:a11y` script there and the gate picks them up. Pass
   `--strict` when cutting a release: it fails on a deferred check.
6. Run `npm run admin -- recovery status` to inspect the recovery control
   state. Use `recovery init` on a fresh installation and `recovery begin`
   plus `recovery complete` after a restore. Run `recovery hold-actions`
   during recovery to disposition the actions a restore left behind.
7. Run `npm run admin -- auth bootstrap` on a fresh installation to print the
   first-passkey enrollment token, and `npm run admin -- auth recover` after
   all passkeys are lost. Set `BASE_URL` to the deployed origin first; the
   token prints once and only its hash is stored.
8. Run `npm run preflight` to check the deployment environment. The
   container entrypoint runs the same checks before it applies migrations.
9. Run `npm run backup` inside the app container for the nightly off-box
   backup, and `npm run restore -- <backup-dir> --yes` to restore one.
   `deploy/README.md` documents the schedule and the recovery runbook a
   restore must continue with.

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
