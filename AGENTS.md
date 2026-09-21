# Personal mail hub development

## Modules

- `apps/web` contains the React client. Its `e2e` folder holds the browser
  checks: a fixture API server that serves the production `dist` build with
  controlled mail data, the `flows` browser workflows, and the `interface`
  accessibility and visual suite. `e2e/DEVICE-MATRIX.md` records which
  browsers and devices the checks ran on, and which platforms — Safari on
  macOS and a real iPhone — stay untested (SPEC F12).
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
- `packages/content` contains derived content extraction over sanitized
  bodies: the pinned Defuddle pass behind the clean view the reader renders
  and the Markdown blockquote a reply draft starts from, each sanitized
  again through the ingestion sanitizer, with plain-text and
  sanitized-original fallbacks, diagnostics reduced to removal counts and
  reasons, and remote extraction refused (`useAsync: false` plus a refusing
  fetch override). The redacted corpus under `test` pins the Markdown and
  clean-view output in snapshots, so a version bump is a deliberate review.
- `packages/classification` contains the Jev integration in shadow mode
  (SPEC F8): the pinned-model TypeSafe adapter behind `TYPE_SAFE_API_KEY`
  with one bounded question set per call, the minimized input (sender,
  subject, and the first 4 KB of body text with quoted chains stripped,
  hashed into each stored decision), the four-level precedence — manual
  placement, sender override, deterministic rules, then Jev for the residual
  — with answers denormalized onto `messages` and raw answers kept in
  `decisions`, and the guardrails the worker's `classify.cycle` queue runs
  under: a circuit breaker that pauses on repeated failures and resumes after
  a cooldown, a monthly cost cap estimated from recorded calls, the
  per-account toggle, and the backfill gate that classifies only mail
  ingested after the latest enabling when backfill is off. Suggestions are
  visible in the reader and route nothing; the health report's circuit state
  comes from the same durable records. Corrections choose their own scope —
  one message, one sender, or the deterministic rule that answered — and
  record one `class.corrected` event each; a sender correction also writes
  the `sender_overrides` row and re-applies it to that sender's mail in the
  account, minus mail the owner placed by hand. The evaluation gate owns the
  routing verdict (SPEC section 12): `npm run eval:classify -- --labels
  <file.jsonl>` measures a hand-labeled set of 100–200 messages against the
  stored answers — critical false negatives (personal or action mail a
  Reading or Notifications bundle would bury, honoring the `security_alert`
  and high-confidence `asks_action` breakout), coverage, and correction rate
  per sender — and records one `class.gate` event. Routing is enabled only
  while the newest `class.gate` event passed with zero critical false
  negatives over at least the 100-message minimum; any later failing run
  returns classification to shadow mode.
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
  and recovery services already record their milestones; the classification
  service records its failures and pauses there, and its circuit state is
  injected as a structural reader so observability stays independent.
- `packages/settings` contains the settings record (SPEC F10): theme,
  reading density, single-key shortcuts, the clean-view default, and the
  classification keys, stored as key-value pairs in the `settings` table
  with one `settings.updated` event per change. Reads merge stored rows
  over the defaults and fall back when a stored value is unusable; writes
  pass the recovery gate, validate the patch, and store only the changed
  keys. `apps/api` serves it at `GET`/`PUT /settings` and exposes the
  per-account synchronization and queue status at `GET /sync/status` over
  the same durable records the health report reads.
- `packages/database` contains the Drizzle schema, SQL migrations, object
  storage, and pg-boss integration, plus the retrying scratch-database cleanup
  (`dropTestDatabase`) the PostgreSQL suites share. Run `npm run db:generate`
  there after changing `src/schema.ts`; apply migrations with
  `npm run db:migrate`.
- `packages/harness` contains the scripted IMAP and SMTP acceptance harness
  (SPEC section 12): one fake IMAP server and one fake SMTP server that speak
  the real wire protocols over TLS leaves signed by the in-repo test
  authority, the mailbox store and deterministic MIME fixtures the suites
  script their scenarios with, and the fault queues that bend one protocol
  step at a time — refusals, stalls, drops, and answers that never come — so
  the production clients run unmodified. Nothing here contacts a real mail
  server or holds real credentials; the transport, send, and restore
  acceptance suites run against it.

## Commands

1. Run `npm install` after you change dependencies.
2. Run `npm run check` before you commit TypeScript changes.
3. Run `npm test` before you commit behavior changes.
4. Run `npm run db:migrate` with `DATABASE_URL` set to apply migrations. The
   migration test suite needs `TEST_DATABASE_URL` and skips without it.
5. Run `npm run release:gate` with `TEST_DATABASE_URL` set before a release.
   The gate first validates the task files — `to-do.json` against
   `to-do.schema.json`, plus every plan link and source document, through
   `npm run validate:tasks` — then runs the workspace type checks, applies
   every migration to a scratch database through the deployment path, runs
   the full test suite and the action-permission suites, and fails when any
   suite skips. It also runs the `apps/web` browser checks: `test:e2e`
   (keyboard, palette, offline, and latency workflows) and `test:a11y` (axe,
   focus, reduced motion, reflow, zoom, and touch targets) against the
   fixture server. Pass `--strict` when cutting a release: it fails on a
   deferred check. Steps stream their output while they run, and a quiet
   step prints a heartbeat at least every 30 seconds. Each step times out
   after 30 minutes unless `RELEASE_GATE_STEP_TIMEOUT_MS` says otherwise
   (`0` disables it). A timeout or an interrupt tears down the step's whole
   process tree before the gate moves on. Run `npm run validate:tasks` on
   its own after you edit `to-do.json`; it needs no database.
6. Run `npm run admin -- recovery status` to inspect the recovery control
   state. Use `recovery init` on a fresh installation and `recovery begin`
   plus `recovery complete` after a restore. Run `recovery hold-actions`
   during recovery to disposition the actions a restore left behind.
7. Run `npm run admin -- auth bootstrap` on a fresh installation to print the
   first-passkey enrollment token, and `npm run admin -- auth recover` after
   all passkeys are lost. Set `BASE_URL` to the deployed origin first; the
   token prints once and only its hash is stored.
8. Run `npm run eval:classify -- --labels <file.jsonl>` with `DATABASE_URL`
   and `RECOVERY_GENERATION` set to measure stored classification answers
   against a hand-labeled set and record the routing verdict. Each label
   line is one JSON object: `messageId`, `class`, and an optional
   `asksAction`. Label 100–200 of your own messages; the exit code is 0 only
   when the gate passes with zero critical false negatives.
9. Run `npm run preflight` to check the deployment environment. The
   container entrypoint runs the same checks before it applies migrations.
10. Run `npm run backup` inside the app container for the nightly off-box
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
