# Personal mail hub minimum viable product (MVP) specification

- **Status:** draft for review
- **Date:** 2026-09-18
- **Version:** 0.5
- **Builds on:** `research/research.md`, `research/research-1.md`, `research/research-2.md`, `research/research-3.md`, `research/modern-email-report-pdf.md`

## 1. Purpose

One self-hosted web client for all personal mail. It connects several
PurelyMail mailboxes across several domains. It gives one place to read,
manage, search, and send — with a dependable core that works without any
model, plus optional Jev classification as an enrichment layer.

The unit of connection is one mailbox: IMAP (Internet Message Access
Protocol) host, username, and password. This covers several PurelyMail
subscriptions, or one subscription with users across domains. Addresses that
route into the same mailbox appear as send identities.

## 2. Goals

1. Centralized reading across N accounts, with one unified inbox and
   per-account views.
2. Cross-account full-text search (FTS) that always works.
3. Two-way management: read, unread, star, archive, and move propagate back
   to the server, so other clients stay in sync.
4. Markdown composing with correct From identity per account.
5. Duplicate-safe sending.
6. Jev classification and grading, in shadow mode first.
7. A minimal, modern interface with consistent controls, a command palette,
   and purposeful microinteractions from the first usable release.

## 3. Non-goals for this version

- AI drafting, agents, and summaries.
- Commitment tracking and work states (phase 2; schema reserved).
- Calendar, contacts, and notifications beyond install-time basics.
- Multi-user support. This product serves one person: you.
- Native mobile or desktop shells. The PWA (progressive web app) only.
- Attachment full-text indexing.

## 4. Product principles

These rules come from the research set and govern every feature:

1. **Core email never waits on a model.** Read, search, compose, and send
   work with Jev disabled, paused, or broken.
2. **Model proposes, code decides.** Every mutation passes a deterministic
   action service. Classification only suggests.
3. **Nothing is hidden.** Bundled views are conveniences. Chronological
   All Mail and search always show everything.
4. **States are honest.** Draft, queued, sent, and outcome unknown are
   distinct. Archive is not done. Read is not resolved.
5. **Originals are the record.** Derived views (Defuddle output, Jev
   answers, snippets) are regenerable and never replace the source.

## 5. Features

### F1 — Account management

- Add an account: label, color, IMAP host and port, SMTP (Simple Mail Transfer
  Protocol) host and port, SMTP security mode, username, and password.
  Defaults point at PurelyMail.
- Require Transport Layer Security (TLS) with certificate and hostname validation.
  IMAP uses implicit TLS on port 993. SMTP defaults to required STARTTLS on
  port 587; implicit TLS on port 465 is also supported. STARTTLS upgrades the
  connection before authentication. Plaintext and optional upgrades are unavailable.
- Test both connections on save. Authenticate, list folders, show counts, and
  discover IMAP capabilities. Verify SMTP authentication without sending mail.
  Report each result separately. A connection test does not verify send identities.
- Map Inbox, Sent, and Archive roles per account. Use server hints, then
  require a manual choice for missing or ambiguous destinations.
- Edit identities per account: address pairs `{address, name}`. One is the
   default. Used by the From picker when composing.
- Per-account toggle: enable or disable Jev classification.
- Credentials are encrypted at rest. See section 9.

### F2 — Sync engine

The hardest component. It follows the checkpoint design in
`research/research-3.md`.

**Backfill**

1. Select the folder and validate `UIDVALIDITY`. Capture `UIDNEXT - 1`
   as `backfill_upper_uid`. UID ranges can be empty or contain gaps.
2. Initialize `backfill_before_uid` to `backfill_upper_uid + 1` and
   `arrival_scanned_uid` to `backfill_upper_uid`.
3. Fetch bounded UID (unique identifier) ranges below `backfill_before_uid`,
   newest first. Store headers and flags; snippets remain empty until fetched.
4. Commit the rows, body jobs, thread reconciliation jobs, and next exclusive
   backfill boundary in one transaction. Advance over empty ranges only after
   a successful fetch.
5. Mark backfill complete when all ranges down to UID 1 are scanned.
   Persist progress independently from new arrivals.
6. Fetch complete messages in background jobs. Store original bytes durably
   before marking bodies fetched. Parse, sanitize, and index derived content.

Use one IMAP connection per account during backfill. Yield between batches
so polls and user actions can run. A restart repeats only uncommitted batches.

**Steady state**

- Poll each Inbox every 60 seconds. Poll other folders every 15 minutes.
- Capture `UIDNEXT - 1` on each poll. Fetch arrivals above
  `arrival_scanned_uid` through that bound, then commit the bound with the rows.
- Refresh flags for existing occurrences. Without change-tracking extensions,
  fetch flags in bounded batches across the folder.
- IDLE is an optional later upgrade. Polling is the baseline.

**Reconciliation**

- Validate `UIDVALIDITY` on every folder selection, before fetches or mutations.
  Never apply a UID from another generation.
- On a change, invalidate old occurrences and queued targets. Reset both
  checkpoints and backfill the new generation. Keep stored originals.
- Compare current UID sets during each poll and mark absent occurrences
  expunged. Run a full folder inventory and UID reconciliation nightly.
- Checkpoints and occurrences belong to one folder generation. Workers must
  discard results if that generation changes before their database commit.
- Emit a sync-status event per account per cycle. Record pending body counts
  separately from header sync progress.

**Message identity and threading**

- A logical message owns content. A mailbox occurrence owns its folder, UID,
  `UIDVALIDITY`, and flags. One logical message can have several occurrences.
- `Message-ID` is a grouping hint, never a unique database key. Missing or
  reused headers must not discard messages.
- Keep provisional logical messages during header import. After fetching
  originals, merge byte-identical messages within an account using a hash.
  Reassign occurrences and derived records in one transaction; preserve events.
- Across accounts, retain separate logical messages. Group rows only when
  original hashes match. Header-only matches remain separate until verified.
  Different delivery headers can keep otherwise similar copies separate;
  this conservative grouping must never suppress an unverified copy.
- Threads belong to one account. Grouping verified copies across accounts does
  not merge their stored threads or change the account used for a reply.
- Resolve the parent from one valid `In-Reply-To` identifier. If absent, use
  the last valid identifier in `References`. Multiple parent identifiers,
  duplicate candidates, self-links, and cycles remain unlinked and flagged as
  ambiguous. Subject and participant matches never create links automatically.
- A missing parent is pending, not permanently unlinked. Store the original
  references and queue reconciliation when headers arrive or logical messages
  merge. Recheck affected children, including previously ambiguous links.
- Recompute affected thread membership after linking or unlinking a parent.
  A later conflicting `Message-ID` must also remove an unsafe existing link.
  Commit links and membership together. Jobs are repeatable after a crash.
- Run thread reconciliation at backfill completion and nightly. Preserve
  message identifiers, flags, and action targets when thread membership changes.
  Navigation follows the selected message if its thread identifier changes.

**Flags, two-way**

- Each action sets a desired flag value; it never toggles a remote value.
  Record the occurrence revision and observed flags when the action is queued.
- Refresh remote flags before execution. If the target already has the desired
  value, return success. Otherwise, a changed occurrence revision or server
  modification sequence returns a conflict. Ask you to refresh and reapply.
- When supported, use Conditional Store (CONDSTORE) writes with
  `UNCHANGEDSINCE` and the captured server modification sequence.
  A rejected condition triggers a refresh and conflict check.
- Otherwise, apply only the requested flag with `+FLAGS` or `-FLAGS`, then
  read it back. Concurrent changes to that flag can still race. Show the latest
  observed server state; do not claim timestamp-based ordering.
- Local observation times are diagnostic. They are not remote change times.
  Pending actions remain visible until confirmed, conflicted, or failed.

### F3 — Reading

- Three panes on desktop: navigation, list, reader. One pane at a time on
   mobile.
- Unified inbox plus per-account sections. Every row carries an account
   color dot.
- Row anatomy: sender, subject, snippet, time, and one state marker.
- Threaded conversations. Collapsed quote chains. "Show trimmed content"
   always available.
- Show received attachments with names, types, and decoded sizes. Downloads use
  authenticated routes and a stable part locator in the stored original.
  Inline images resolve Content-ID within that message only. Ambiguous identifiers
  remain download items. Cache regeneration follows the rules in section 8.
- Remote images blocked by default. A **Load images** button appears per
   message. This blocks read trackers.
- Optional **clean view** toggle per message: Defuddle extraction, then
   DOMPurify, then render. The sanitized original stays one click away.
- Keyboard-first: `j`/`k` move, `o` open, `e` archive, `s` star,
   `u` unread, `r` reply, `/` search. F11 defines shortcut scope and focus rules.

### F4 — Management actions

- Actions: mark read, mark unread, star, unstar, archive, move to folder.
- Bulk select freezes explicit occurrence targets, including their folder
  generation and revision. Show message and occurrence counts before execution.
- A grouped row expands to active occurrences in the current view. Inbox
  actions affect Inbox occurrences only. Show account and folder scope.
- An unread or starred row means at least one visible occurrence has that flag.
- Archive moves selected occurrences to the account's configured archive
  folder. Require a destination before queueing. Reject cross-account moves.
- Use IMAP `MOVE` only when supported. Otherwise report move and archive as
  unavailable in this version. Do not use a general `EXPUNGE` fallback.
- A lost move response requires reconciliation. Do not replay the move blindly.
  Retain an unknown outcome if the destination cannot be identified safely.
- Every action goes through the action service (section 7) and writes an
   event.

### F5 — Search

- One box across all accounts by default. Account and domain filter chips
   narrow it.
- FTS covers sender, recipients, subject, and body in one weighted vector.
  Header fields enter the index in the header import transaction. Body text
  enters after fetching; a missing body never excludes header matches.
- Confirmed outgoing mail enters `messages` and the index in the acceptance
  transaction, before its Sent copy is appended. It appears in All Mail,
  search, its conversation, and Sent while the append is unresolved.
  Show the append status and accepted recipients separately. After a confirmed
  append, Sent membership follows active folder occurrences.
- Enable `pg_trgm` and index normalized sender and subject text for prefix
  queries. Normalize query text with the same function used at ingestion.
- Show body indexing progress. Full-body results are incomplete during backfill.
- `domain:` matches address domains in sender or recipients. `before:` and
  `after:` use exclusive Coordinated Universal Time (UTC) date boundaries against `sent_at`, falling back
  to the earliest stored server internal date for that logical message.
  Reject invalid dates and unknown operators.
- Flag filters match active occurrences in the selected account and folder
  scope. All Mail and default search also include retained local messages,
  labeled "no server copy". A local archive filter selects these records.
  Outgoing records also show whether the Sent copy is pending, failed, or unknown.
  Disable server actions for records without active occurrences.
- Operators: `from:`, `to:`, `domain:`, `is:unread`, `is:flagged`,
   `has:attachment`, `type:` (Jev class), `is:action`, `before:`, `after:`.
- Results show the holding account. A click opens the message in its thread.
- Search works with classification disabled. `type:` and `is:action`
   simply match nothing then.

### F6 — Markdown composing

- Editor: CodeMirror 6 with Markdown highlighting and a live preview pane.
- Preview renders through `markdown-it`, then sanitizes with DOMPurify.
   Raw HTML in the source is escaped, not passed through.
- Markdown is the source of truth. The draft stores it verbatim.
- Body format, `multipart/alternative`; wrap it in `multipart/mixed` when adding files:
  - `text/html`: sanitized render, wrapped in a minimal template with
    inline CSS (cascading style sheets) only. Email clients strip
    stylesheets.
  - `text/plain`: the Markdown source itself.
- Reply quoting: Defuddle with `markdown: true` converts the parent message
   to a Markdown blockquote. You trim it before sending.
- Reply targets one selected message and its holding account. If a grouped row
  has copies in several accounts, require an account choice before creating
  the draft. Freeze that context; do not infer it from the whole thread.
- **Reply** uses the parent's valid `Reply-To` addresses, or `From` when
  `Reply-To` is absent. A malformed or empty `Reply-To` requires recipient
  correction. Show the resulting addresses before send.
- **Reply all** uses the same primary recipients. Add the parent's visible
  To and carbon copy (Cc) addresses to Cc. Remove duplicates and all configured
  identities from the recipient lists. Never copy blind carbon copy (Bcc)
  recipients. If no recipients remain, require an explicit choice.
- For your own sent message, reuse its visible To/Cc recipients and From
  identity when that identity is still configured. Do not copy its Bcc list.
- For received mail, preselect From only when exactly one identity on the
  chosen account matches the parent's To/Cc. Otherwise require a choice,
  including for blind copies and ambiguous aliases. Untrusted delivery headers
  do not select an identity. New messages use the account's default identity.
- Freeze the reply headers with the draft. Set `In-Reply-To` to the parent's
  valid `Message-ID`. Set `References` to its valid References followed by that
  identifier. If it has no References, use its single valid `In-Reply-To`
  before appending its identifier. Omit unavailable identifiers; never invent them.
  The queued snapshot preserves these headers even if thread membership changes.
- Attachments: plain file adds. Names and sizes shown before send.
- Uploaded files belong to drafts, not received messages. Persist each upload
  in durable storage before acknowledging it. Offline bytes remain in Dexie
  until upload acknowledgement; report browser quota errors without queueing.
- Queue a send only after all referenced files are uploaded and verified.
  Outbound references keep files alive even when the draft is deleted.

**Defuddle rules**

- Output is derived, never stored as the record.
- Pin the version. Snapshot-test the output so upgrades are deliberate.
- On extraction failure, clean view falls back to the sanitized original.
  Reply quoting falls back to the plain-text part, or text extracted from
  sanitized HTML, then forms a Markdown blockquote. Never insert raw HTML
  into the Markdown source as a fallback.
- Disable asynchronous remote extraction with `useAsync: false`. Apply the
  remote-image policy to clean view and compose preview as well as the reader.
- Use `debug: true` only with redacted development fixtures. Diagnostic logs
  contain removal counts and reasons, never removed text or raw HTML.
- Defuddle is not a sanitizer. Its output passes through DOMPurify.

### F7 — Sending

Duplicate safety means the app never automatically resubmits an uncertain
SMTP attempt. SMTP does not provide an exactly-once delivery guarantee.
The recovery generation identifies the current database history. It changes
after a restore; section 10 defines the procedure.

1. Validate the recovery generation, draft revision, identity, recipients, and
   completed uploads. Reject requests from an earlier recovery generation.
   Freeze the From identity, envelope sender and recipients, visible headers,
   reply headers, Markdown, and attachments. Generate `Message-ID` and `Date` once.
2. Build and durably store the exact Multipurpose Internet Mail Extensions
   (MIME) bytes. Keep Bcc recipients out of those bytes; retain them in the
   envelope snapshot. Validate parsing and prepare sanitized derivatives before
   submission. Commit the snapshot, recovery generation, idempotency key,
   action receipt, draft lock, and job in one transaction.
3. Claim the queued row atomically. Persist `sending` before opening SMTP.
   A repeated key returns the existing result. A different payload with that
   key returns a conflict. Never consult the mutable draft during sending.
4. Record recipient responses and the final SMTP response. A positive final
   response means `sent` for accepted recipients, not delivery to their inboxes.
   If some recipients were rejected, show partial acceptance explicitly.
   In one transaction, set `sent`, create or reuse the local message by its
   account and original hash, link it through `logical_message_id`, and commit
   its body, attachments, search text, receipts, event, and reconciliation jobs.
   The transaction also creates the Sent append job.
5. Run the separate Sent append job using the stored MIME bytes.
   SMTP state remains `sent` if append fails. Append retries cannot
   invoke SMTP. Track pending, appending, stored, failed, and unknown states.
6. A definitive rejection before acceptance means `failed`. Return the draft
   to editing. A lost final response or abandoned `sending` attempt means
   `outcome_unknown`. No automatic resend follows an uncertain attempt.
7. Reconcile using durable responses and any available server evidence.
   An empty Sent folder does not prove failure. A Sent copy alone does not
   prove delivery. Keep unresolved attempts unknown and show the reason.

Only one worker may submit a given outbound row. Worker lease expiry does
not authorize another submission. Fence stale workers and reconcile before
any further action. On startup, treat abandoned `sending` rows as unknown.

A deliberate resend creates a new snapshot and key after you acknowledge
possible duplicate delivery. Confirmed failures can be edited and queued with
a new key. Never resend to accepted recipients as part of a partial retry.

For Sent append, persist `appending` before the remote call. After an uncertain
append, search by the generated identifier and verify candidate content.
Do not append again until reconciliation proves absence. Otherwise retain
`unknown`. Record the destination UID and `UIDVALIDITY` when confirmed.

Lock a queued draft against edits. A definitive failure unlocks it. Preserve
unknown attempts for review; creating an editable copy must not cancel them.

**Local sent record**

- The accepted message references the stored outbound MIME object as its
  original. Set its body as fetched. Index the frozen sender, subject, body,
  and recipients. Bcc addresses remain private local metadata from the envelope.
- Do not create a server occurrence until the server copy is confirmed.
  Server flags and actions remain unavailable without an active occurrence.
- Sent import merges with the local message only after verifying the account
  and original hash. Attach the confirmed occurrence to that message and update
  the outbound link when provisional records merge. `Message-ID` alone is insufficient.
- Repeated acceptance handling creates one logical message. Definitive failures
  and unknown attempts remain in the outbox, without a false local sent record.
  If later evidence confirms acceptance, run the same local indexing transaction.

Section 10 defines recovery after a restore. Its generation check runs before
idempotency lookup and worker execution, including when a restored database
has no record of a request that a device retries.

### F8 — Jev classification

Jev answers bounded questions. It never generates text and never gates
anything.

**Question set, one call per message**

| Question | Kind | Output field |
| --- | --- | --- |
| Message type: correspondence, receipt, newsletter, notification, marketing, security alert, bounce, other | Choice | `class_hint` |
| Sender relationship: known contact, service in use, bulk sender, unknown | Choice | metadata |
| Does this message ask you to act? | Yes/no with confidence | `asks_action` |
| Does this message ask you to reply? | Yes/no with confidence | `asks_reply` |
| Is it time-sensitive? | Yes/no with confidence | `time_sensitive` |

Jev does no date math. Code extracts and compares dates; Jev only judges
time sensitivity.

**Pipeline**

- Async pg-boss job per logical message, after body storage and extraction.
- Input minimization: sender, subject, and the first 2–4 KB of extracted
   text. No attachments. Quoted chains stripped.
- Answers land in `decisions` (raw) and denormalize onto `messages`.
- Pin the model version. `jev-latest` moves; thresholds need stable
   behavior.

**Precedence, top wins**

1. Your manual placement of a message.
2. Your sender override.
3. Deterministic rules: regex and known-sender lists (bank statements, 2FA
   codes). No API call spent.
4. Jev, for the residual.

**Guardrails**

- Shadow mode first: Jev output appears as a visible suggestion on each
   message. It routes nothing until the evaluation in section 12 passes.
- After enablement: newsletters bundle into Reading, notifications into a
   Notifications strip. All Mail and search stay complete.
- Breakout rule: `security_alert` or high-confidence `asks_action` exits
   any bundle, regardless of sender history.
- Circuit breaker: repeated timeouts or errors pause the classify queue.
   Mail keeps flowing. The UI shows "classification paused".
- Cost cap: a monthly ceiling in settings. Over it, classification pauses.
- Per-account disable toggle.

**Corrections**

At correction time, choose scope: **this message only**, **this sender**,
or **edit the deterministic rule**. Corrections are events.

### F9 — Drafts and offline

- Drafts autosave to PostgreSQL. Debounced at 2 seconds.
- The PWA keeps a Dexie (IndexedDB) store: recent conversations, local
   drafts, and a durable queue of pending actions.
- Offline contract: read downloaded messages, keep drafting, queue
   supported actions. The UI always shows what has not synchronized.
- A locally queued send uploads when connectivity returns. Show it as
  "waiting on this device" until the server accepts the snapshot and key.
- Each draft update includes its base revision. Reject stale updates and
  prompt a choice. Never silently overwrite another device's draft.
- Offline actions retain their original occurrence targets and idempotency
  keys. Reconnection never expands their scope to newly arrived messages.
- Each local draft revision, upload request, and queued action also retains
  the recovery generation issued by the server when it was created.
  Reconnection never replaces that generation automatically.
- A generation mismatch stops replay and shows "server restored; review pending
  changes". Retain local text and files. Rebase a draft only after an explicit
  comparison with server state. An uncertain send requires the duplicate warning
  in F7 before a new snapshot and key can be created.

### F10 — Settings

- Stored in the `settings` table as key-value pairs.
- Keys include: classification enabled, monthly Jev cost cap, backfill
   classification on or off, reading density, clean view default, theme,
   and single-key shortcuts enabled. Theme choices are system, light, and dark.
- Compact density is the default. Comfortable density remains available.

### F11 — Command palette

The command palette is the application's control panel. It ships in the MVP.

- Open with `Cmd+K` on macOS or `Ctrl+K` elsewhere. Keep a visible **Commands**
  button with the platform shortcut. Mobile uses the same button.
- Reserve `Cmd+P` and `Ctrl+P` for printing. Do not override them.
- Open one searchable dialog. Group results into navigation, message actions,
  compose, and settings. Show labels, shortcut hints, and current target scope.
- Include Inbox, All Mail, account and folder switching, search, new message,
  reply, reply all, read/unread, star/unstar, archive, move, theme, and settings.
- Use local command filtering. Opening and filtering commands must not depend
  on the network or classification. Mail search opens F5 with the query.
- Contextual commands use the focused message or explicit selection. Display
  the frozen account, folder, and occurrence scope before a bulk mutation.
  Disable unavailable commands with a reason. Never infer a wider scope.
- `Up` and `Down` select results; `Enter` activates; `Escape` closes or exits
  a nested choice. Selecting **Move** first opens a destination chooser.
- The dialog traps focus and restores it to the opener. If that item no longer
  exists, move focus to the nearest surviving list item or list heading.
- Use the same command registry for the palette, menus, buttons, and shortcuts.
  Each command defines its label, availability, target rules, and action handler.
  Mail mutations still pass through section 7.
- **Send** opens the addressed draft for review. It never submits a message
  directly from the palette. Actual submission uses the compose send control.

Single-key shortcuts are inactive in inputs, editable content, CodeMirror,
and dialogs. Provide a setting to disable them. Ignore composing text events
and key repeats for mutations. Bind each shortcut once; one key event must
never submit two actions. The palette shortcut works from the editor without
changing draft text. Test opening from the sandboxed message reader; provide
an outer focus target when iframe isolation prevents shortcut handling.

### F12 — Visual system and microinteractions

**Design direction**

The primary devices are macOS and iPhone. The selected design references are
Linear for restraint, Raycast for the command palette, and Superhuman for mail
triage. These guide visual and interaction decisions throughout the MVP.

Design for reading at a desk in daylight and on an iPhone in the evening.
Use a system-following theme with fully designed light and dark appearances.
Mail content sits on stable, opaque surfaces. Preserve sender HTML colors
inside the isolated reader; provide a readable text view for poor contrast.

- Use restrained neutral surfaces and one accent for primary actions and
  selection. Keep account colors small and pair them with names or icons.
- Use typography, spacing, and alignment to organize the three panes.
  Prefer message rows and separators over repeated cards.
- Use one system sans-serif stack. Start with 14px interface text and 16px
  reading text, expressed in relative units. Keep prose near 65–75 characters
  per line. Compact density is the default; comfortable density is optional.
  Both share the same hierarchy. Compact mode reduces row padding, not text
  legibility or touch target size.
- Centralize semantic colors in CSS custom properties using OKLCH. Define
  surface, text, muted text, border, accent, selection, focus, and status roles.
  Components reference these roles instead of individual color values.
- Share a 4px spacing scale, 6–12px control radii, and one Lucide icon style.
  Set common control heights and padding through tokens. Preserve 44px touch
  targets on mobile, including controls whose visible icons are smaller.
- Use one component variant for each purpose across all screens. Specify
  default, hover, focus, pressed, selected, disabled, pending, and error states
  wherever applicable. Tooltips supplement accessible labels.
- Keep primary controls discoverable without hover. Hover can reveal secondary
  actions; keyboard focus and touch must expose equivalent controls.

**Required interaction details**

| Interaction | MVP behavior |
| --- | --- |
| Hover and press | Subtle surface feedback; stable label and icon positions. |
| Command palette | Focus the query immediately; fade and move at most 4px on entry. Results remain responsive during animation. |
| Message selection | Update the selection immediately. Keep row height and list scroll stable while the reader loads. |
| Star and read state | Change the local icon immediately and mark it pending. Confirm quietly; show a recoverable error if the server rejects it. |
| Archive and move | Preserve focus and scroll as confirmed rows leave the current view. Pending scope remains inspectable. Do not show success before confirmation. |
| Draft save | Show unsaved, saving, saved, and offline-local states in one stable location. Never steal focus. |
| Send | Show queued, sending, sent, partial acceptance, failed, or unknown accurately. Keep Sent-copy status separate. |
| Loading | Use layout-matched skeletons for uncached content. Keep existing content visible during refresh. |
| Empty and error states | State what happened and provide one useful next action. Keep persistent failures inspectable after a toast disappears. |

Use CSS transitions for simple state changes. Use Motion for React for dialog
entry, exit, and coordinated state transitions. Define shared duration tokens:
100ms for feedback, 160ms for controls, and 220ms for panels. Use ease-out curves
without bounce. Actions never wait for an animation to finish.

Animate opacity and transforms where possible. Avoid list-wide entrance
animations and changes to layout that move the reading position. New mail
must not pull the reader away from the current message or selection.

Honor `prefers-reduced-motion` in both CSS and Motion. Remove movement and
scale effects; use instant state changes or brief fades. Disable animated
skeletons under reduced motion. All state information remains available.

**Responsive behavior and accessibility**

- At wide widths, show navigation, list, and reader. Collapse navigation first,
  then use one pane at a time when readable minimum widths no longer fit.
- Prioritize macOS keyboard workflows and iPhone touch workflows. Display
  native Mac shortcut symbols, including `⌘K`, on macOS.
- iPhone back navigation restores list position and selection. Compose and
  command dialogs remain usable above the on-screen keyboard. Respect safe
  areas and changing viewport height. Keep Send and Commands within reach.
- Test Safari on macOS and iPhone, including the installed iPhone PWA.
  Also test a Chromium browser on macOS. Record browser and operating system
  versions used for release checks; the user's browser choice is not assumed.
- Meet Web Content Accessibility Guidelines (WCAG) 2.2 AA. Verify text contrast,
  visible focus, control contrast, accessible names, and keyboard operation.
- Announce action completion and errors without announcing every poll or save.
  Preserve focus when virtualized rows leave the viewport.
- Support 200% text zoom and 320px viewport reflow for application controls.
  Wide email tables scroll inside the reader rather than widening the shell.

## 6. Architecture

```
React + Vite PWA
  shadcn/ui + Radix · Tailwind CSS · cmdk · Motion
  three-pane UI · CodeMirror · Dexie offline store
        │  HTTPS (Coolify proxy terminates TLS)
Fastify API (single process)
  routes · auth · action service · search
        │
PostgreSQL (Coolify resource)
  data · FTS · pg-boss queues
        │
inline worker (same process)
  imapflow sync · mailparser · nodemailer send
  defuddle quoting · Jev adapter (TypeSafe API)
        │
Storage interface → durable originals and uploads + disposable derived cache
```

Libraries:

| Concern | Choice |
| --- | --- |
| UI framework and build | React + Vite + TypeScript |
| Components | `shadcn/ui`, consistently using the Radix variant |
| Styling | Tailwind CSS + shared semantic CSS variables |
| Command palette | `cmdk` through the shared command dialog |
| Motion | CSS transitions + Motion for React (`motion/react`) |
| Icons | `lucide-react` |
| IMAP client | `imapflow` |
| MIME parsing | `mailparser` |
| SMTP send | `nodemailer` |
| HTML sanitizing | `DOMPurify` (server and client) |
| HTML to Markdown | `defuddle` (Node bundle, linkedom) |
| Markdown to HTML | `markdown-it` |
| Editor | `CodeMirror 6` |
| Jobs | `pg-boss` |
| ORM (object-relational mapping) | `Drizzle` |
| Offline store | `Dexie` |

The package uses `"type": "module"` for the Defuddle Node bundle.

Keep shadcn component source in `src/components/ui`. Customize those components
and shared tokens centrally. Feature screens compose these components instead
of defining separate button, dialog, menu, or input styles. Use Radix primitives
consistently rather than mixing primitive families. Pin dependency versions.
`PRODUCT.md` records the design intent; F11 and F12 define MVP acceptance.

## 7. The action service

One internal module owns mail mutations: send, mark read, star, archive,
and move. Draft updates and settings use authenticated, revision-aware routes.
Each mail action follows this procedure:

1. Check the request's recovery generation before idempotency lookup. Reject an
   old generation with `409 recovery_required`. Then require recovery mode
   `ready`. Validate the account, immutable request, key, and scope.
2. Commit an action record and work item before remote execution. Repeated
   keys return existing results; changed payloads with the same key conflict.
3. Refresh occurrence state from IMAP. Check folder generation and local
   revision. Reject stale targets, except confirmed no-op flag assignments
   under F2. Sends follow the snapshot rules in F7.
4. Recheck the recovery generation before execution and every remote mutation.
   Execute the operation. Persist per-item progress so a partial bulk
   failure does not replay successful items.
5. Commit observed state, per-item receipts, and events together. Return
   confirmed, conflicted, failed, or unknown outcomes for each target.
6. On restart, reconcile incomplete actions. Replay a flag assignment only
   after refreshing its target. Never blindly replay sends or moves.

A database transaction cannot include an IMAP or SMTP side effect. The
persistent action record and reconciliation handle that gap. Optimistic user
interface state remains marked pending until the service confirms it.

The web interface is one caller. Phase 2 agents use the same functions.
Draft, upload, and settings mutations use the same recovery gate. Authentication
and operator recovery have separate routes. Jobs retain their original generation;
lease renewal or queue retry never upgrades it.

## 8. Data model

```sql
create extension if not exists pg_trgm;

create table service_state (
  singleton           boolean primary key default true check (singleton),
  recovery_generation uuid not null,
  recovery_mode       text not null default 'ready'
    check (recovery_mode in ('ready', 'reconciling')),
  updated_at          timestamptz not null default now()
);

create table accounts (
  id               uuid primary key default gen_random_uuid(),
  label            text not null,
  color            text not null,
  imap_host        text not null default 'imap.purelymail.com',
  imap_port        int  not null default 993,
  imap_security    text not null default 'implicit_tls'
    check (imap_security = 'implicit_tls'),
  smtp_host        text not null default 'smtp.purelymail.com',
  smtp_port        int  not null default 587,
  smtp_security    text not null default 'starttls_required'
    check (smtp_security in ('starttls_required', 'implicit_tls')),
  username         text not null,
  password_enc     text not null,             -- AES-256-GCM, key from env
  identities       jsonb not null default '[]',
  classify_enabled boolean not null default true,
  created_at       timestamptz not null default now()
);

create table folders (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts,
  name          text not null,                -- IMAP path
  role          text,                         -- inbox|sent|drafts|archive|trash|junk
  uidvalidity   bigint,
  arrival_scanned_uid bigint not null default 0,
  backfill_upper_uid bigint,
  backfill_before_uid bigint,
  backfill_complete boolean not null default false,
  unique (id, account_id),
  unique (account_id, name)
);

create unique index on folders (account_id, role) where role is not null;

create table threads (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts,
  subject_norm  text,
  participants  jsonb not null default '[]',
  updated_at    timestamptz not null default now(),
  unique (id, account_id)
);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts,
  message_id      text,
  in_reply_to     text,
  reference_ids   jsonb not null default '[]',
  thread_id       uuid,
  parent_message_id uuid,
  thread_link_state text not null default 'pending', -- root|pending|linked|ambiguous
  sender          jsonb,
  reply_to        jsonb,                      -- null: absent; []: invalid or empty
  recipients      jsonb,
  subject         text,
  sent_at         timestamptz,
  snippet         text,
  has_attachments boolean not null default false,
  size_bytes      bigint,
  fetched_body    boolean not null default false,
  class_hint      text,                       -- denormalized latest Jev answer
  asks_action     boolean,
  asks_reply      boolean,
  time_sensitive  boolean,
  metadata        jsonb not null default '{}',
  original_storage_key text,                  -- durable complete MIME bytes
  original_sha256 text,                       -- null until fetched
  sender_text     text not null default '',
  recipients_text text not null default '',
  subject_text    text not null default '',
  body_index_text text not null default '',
  search          tsvector generated always as (
    setweight(to_tsvector('simple', sender_text), 'A') ||
    setweight(to_tsvector('simple', recipients_text), 'A') ||
    setweight(to_tsvector('simple', subject_text), 'A') ||
    setweight(to_tsvector('simple', body_index_text), 'B')
  ) stored,
  unique (id, account_id),
  foreign key (thread_id, account_id) references threads (id, account_id),
  foreign key (parent_message_id, account_id) references messages (id, account_id),
  check (parent_message_id <> id),
  check (thread_link_state in ('root', 'pending', 'linked', 'ambiguous')),
  check ((thread_link_state = 'linked') = (parent_message_id is not null))
);
create index on messages (thread_id);
create index on messages (account_id, sent_at desc);
create index on messages (message_id);
create index on messages (account_id, in_reply_to);
create index on messages using gin (reference_ids);
create index on messages (class_hint) where class_hint is not null;

create index on messages using gin (search);
create index on messages using gin (sender_text gin_trgm_ops);
create index on messages using gin (subject_text gin_trgm_ops);
create unique index on messages (account_id, original_sha256)
  where original_sha256 is not null;

create table message_occurrences (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts,
  message_id    uuid not null,
  folder_id     uuid not null,
  uidvalidity   bigint not null,
  uid           bigint not null,
  internal_date timestamptz not null,
  unread        boolean not null default true,
  flagged       boolean not null default false,
  modseq        numeric(20, 0),                -- optional server revision
  revision      bigint not null default 1,    -- local observed-state revision
  observed_at   timestamptz not null default now(),
  expunged_at   timestamptz,
  invalidated_at timestamptz,
  foreign key (message_id, account_id) references messages (id, account_id),
  foreign key (folder_id, account_id) references folders (id, account_id),
  unique (folder_id, uidvalidity, uid)
);
create index on message_occurrences (message_id);
create index on message_occurrences (folder_id, uid)
  where expunged_at is null and invalidated_at is null;

create table bodies (
  message_id    uuid primary key references messages,
  text_plain    text,
  html_sanitized text,                        -- derived rendering only
  sanitizer_version text not null
);

create table attachments (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references messages,
  part_path    text not null,                 -- position in the original MIME tree
  locator_version smallint not null default 1 check (locator_version > 0),
  decoded_sha256 text not null,               -- verify regenerated decoded bytes
  content_id   text,                          -- MIME Content-ID; not a unique key
  disposition  text,                          -- attachment|inline, if present
  filename     text,
  content_type text,
  size_bytes   bigint not null check (size_bytes >= 0), -- decoded size
  storage_key  text,                          -- disposable extracted copy
  fetched_at   timestamptz,
  unique (message_id, part_path)
);

create table drafts (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references accounts,
  identity       jsonb not null,
  thread_id      uuid,
  reply_parent_id uuid,
  in_reply_to    text,
  reference_ids  jsonb not null default '[]',
  recipients     jsonb not null default '{}',
  subject        text,
  markdown       text not null default '',
  revision       bigint not null default 1,
  locked_by_send uuid,                        -- FK added after outbound table
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  foreign key (thread_id, account_id) references threads (id, account_id),
  foreign key (reply_parent_id, account_id) references messages (id, account_id)
);

create table uploads (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references accounts,
  filename     text not null,
  content_type text not null,
  size_bytes   bigint not null,
  storage_key  text unique not null,           -- durable, immutable upload
  sha256       text not null,
  created_at   timestamptz not null default now()
);

create table draft_uploads (
  draft_id  uuid not null references drafts,
  upload_id uuid not null references uploads,
  ordinal   int not null,
  primary key (draft_id, upload_id),
  unique (draft_id, ordinal)
);

create table outbound_messages (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts,
  recovery_generation uuid not null,
  idempotency_key text unique not null,
  request_hash    text not null,
  draft_id        uuid references drafts,
  draft_revision  bigint not null,
  identity        jsonb not null,             -- frozen From address and name
  envelope_sender text not null,
  envelope_recipients jsonb not null,
  status          text not null,   -- queued|sending|sent|failed|outcome_unknown
  logical_message_id uuid unique,             -- populated on confirmed acceptance
  thread_id       uuid,
  reply_parent_id uuid,
  in_reply_to     text,
  reference_ids   jsonb not null default '[]',
  recipients      jsonb not null,
  subject         text,
  markdown_source text not null,
  html            text,
  rfc_message_id  text unique not null,        -- generated before SMTP
  mime_storage_key text not null,             -- durable exact submitted bytes
  mime_sha256     text not null,
  smtp_response   jsonb,                      -- protocol result, no credentials
  recipient_results jsonb not null default '[]',
  sending_started_at timestamptz,
  sent_copy_status text not null default 'pending',
  sent_folder_id uuid references folders,
  sent_uidvalidity bigint,
  sent_uid       bigint,
  last_error     jsonb,
  check (status in ('queued', 'sending', 'sent', 'failed', 'outcome_unknown')),
  check (sent_copy_status in ('pending', 'appending', 'stored', 'failed', 'unknown')),
  check (status <> 'sent' or logical_message_id is not null),
  foreign key (thread_id, account_id) references threads (id, account_id),
  foreign key (logical_message_id, account_id) references messages (id, account_id),
  foreign key (reply_parent_id, account_id) references messages (id, account_id),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

alter table drafts add foreign key (locked_by_send) references outbound_messages;

create table outbound_uploads (
  outbound_id uuid not null references outbound_messages,
  upload_id   uuid not null references uploads,
  ordinal     int not null,
  primary key (outbound_id, upload_id),
  unique (outbound_id, ordinal)
);

create table actions (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts,
  recovery_generation uuid not null,
  idempotency_key text unique not null,
  request_hash    text not null,
  kind            text not null,
  request         jsonb not null,             -- immutable scope and desired state
  status          text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table action_items (
  action_id    uuid not null references actions,
  item_key     text not null,
  target       jsonb not null,                -- occurrence + generation + revision
  status       text not null,                 -- queued|executing|confirmed|conflicted|failed|unknown
  outcome      jsonb,
  updated_at   timestamptz not null default now(),
  primary key (action_id, item_key)
);

create table decisions (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references messages,
  input_hash   text not null,      -- hash of the exact text sent
  model        text not null,      -- pinned version
  question_set text not null,
  answers      jsonb not null,
  confidence   jsonb,
  latency_ms   int,
  created_at   timestamptz not null default now()
);

create table sender_overrides (
  account_id   uuid not null references accounts,
  sender       text not null,
  class_hint   text,
  note         text,
  primary key (account_id, sender)
);

create table conversation_state (   -- reserved for phase 2; unused now
  conversation_id uuid primary key,
  work_state      text,             -- needs_reply|waiting|later|done
  snoozed_until   timestamptz,
  updated_at      timestamptz not null default now()
);

create table events (
  id          uuid primary key default gen_random_uuid(),
  at          timestamptz not null default now(),
  actor       text not null,        -- user|system|api
  type        text not null,        -- message.read, send.queued, class.corrected …
  entity_type text,
  entity_id   uuid,
  payload     jsonb not null default '{}'
);

create table settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
```

Notes:

- The FTS configuration is `simple`. It is predictable across languages,
  which matters for multilingual personal mail. Switching to a stemming
  language later is a reindex, not a redesign.
- Original MIME bytes are durable records, including raw HTML and attachments.
  Never render originals directly. `bodies` contains sanitized derivatives only.
- Body parsing and the `messages.body_index_text` update commit together.
  Header indexing does not wait for a body row.
- Accepted outgoing mail uses the same message and body tables. Acceptance,
  its outbound link, search fields, and the append job commit together.
  Import must preserve local recipient metadata from the outbound envelope.
- `reply_to` preserves the difference between an absent header and an invalid
  header. Reply drafts keep the selected parent and frozen wire references.
  Logical message merges reassign parent and outbound links transactionally.
  Immutable action requests retain the original identifiers for hash comparison;
  local association links can follow the canonical records after a merge.
- Thread roots have no usable parent reference. Pending links have no matching
  parent yet. Ambiguous links cannot select one safe parent. Reconciliation
  updates these states and thread membership together. Keep old thread records
  while drafts or snapshots still reference them; navigation uses message IDs.
- Attachment locator version 1 uses `/` for the MIME root. Append one-based
  child positions for each multipart level, for example `/2/1`. A nested
  `message/rfc822` payload is child `1` of its wrapper. This path describes
  the original structure before sanitizing or extraction; it is not an IMAP UID.
- To regenerate an attachment, verify the original hash, resolve its stored
  path, and verify the decoded hash and size. Keep the attachment ID unchanged.
  An unsupported locator version or mismatched bytes returns an error.
  Never guess by filename, Content-ID, or size. Parser upgrades must preserve
  supported locators or migrate them with byte verification.
- Resolve duplicate original hashes before inserting attachment rows. Reuse
  existing part rows on repeated parsing, so byte-identical copies do not
  create competing attachment IDs for the same logical message and path.
- Active occurrences have neither `expunged_at` nor `invalidated_at` set.
  Retain originals after server expunges. Show them in All Mail, search,
  and the local archive filter; never pretend they still exist on the server.
- Account boundaries apply to drafts, uploads, outbound snapshots, and action
  targets. Validate all reference ownership in the action transaction.
- Upload links, identity, envelope, content, reply headers, recovery generation,
  and MIME bytes become immutable when queued. Only execution state, receipts,
  and local association links can change. Association changes never alter wire bytes.
- Durable storage writes finish before referencing transactions commit.
  Garbage collection removes only unreferenced objects after a grace period
  longer than the backup window. It never deletes active draft or send assets.
- This schema specifies mail storage. Authentication credentials and sessions
  require separate migrations before any externally accessible deployment.
  Those migrations enforce one owner, unique credential IDs, revocable sessions,
  and expiring, single-use challenges and enrollment grants. Grants store token
  hashes, never raw tokens. Section 9 defines the required lifecycle.
- `service_state` must contain one row before normal operation. Compare its
  generation with `RECOVERY_GENERATION` from deployment configuration on startup.
  Missing state or a mismatch blocks mail mutations and all workers. Only fresh
  installation or the operator recovery command can initialize this state.
- `conversation_state` exists to reserve the three-state separation from
  the report. No code path reads it in this version.

## 9. Security and privacy

- **Authentication:** one owner, with Web Authentication (WebAuthn) passkeys.
  Sessions use `HttpOnly`, `Secure`, and `SameSite=Strict` cookies. Validate
  the request origin on authenticated mutations. No public owner registration.
- **Mail transport:** set ImapFlow `secure: true`. For SMTP STARTTLS, set
  `secure: false`, `requireTLS: true`, `ignoreTLS: false`, and
  `opportunisticTLS: false`. For implicit TLS, set `secure: true`.
  Validate certificate chains and the configured hostname for both protocols.
  Missing encryption, expired certificates, and hostname mismatches fail before
  authentication. Tests use a trusted test authority, never disabled validation.
  See the [ImapFlow connection options](https://imapflow.com/docs/api/imapflow-client/)
  and [Nodemailer TLS options](https://nodemailer.com/smtp#tls-options).
- **Credential encryption:** mailbox passwords use AES-256-GCM with
  `CREDENTIALS_KEY` from the environment. Back up this key separately from
  the database. Losing it loses the stored credentials.
- **HTML rendering:** DOMPurify server-side at ingest. Client renders in a
   sandboxed iframe with a restrictive CSP (content security policy).
- **Data egress:** mail synchronization, sending, backups, and explicit remote
  image loading use their configured destinations. Optional Jev calls send
  sender, subject, and truncated text only. State these flows in settings.
- **Tracking:** remote images blocked by default. No outbound tracking of
   any kind.
- **Logs:** no message bodies or credentials in logs.

**Passkey setup and recovery**

- Set `BASE_URL` to the deployed HTTPS origin before enrollment. Verify the
  WebAuthn origin against that value and the relying party identifier against
  its hostname. Require user verification. Challenges expire after five minutes
  and are single-use, with a fixed owner, purpose, and recovery generation.
  Follow the [WebAuthn verification requirements](https://www.w3.org/TR/webauthn-3/#sctn-rp-operations).
- On a fresh installation, run `npm run admin -- auth bootstrap` inside the
  app container. This operator command requires no existing owner. It initializes
  `service_state` only when the database has no owner, mail, or queued work.
  Missing control state in a populated database requires restore recovery instead.
- The command creates a 256-bit random enrollment token that expires after
  ten minutes. Store only its hash. Print it once to the operator's terminal;
  exclude it from application logs. Paste it into the setup form, never a URL.
  A new grant invalidates any earlier grant for the same purpose.
- The token authorizes only first-passkey registration. Commit its consumption,
  the single owner, and the credential together. Concurrent registration attempts
  cannot create a second owner or reuse the grant. Setup then closes.
- Adding or removing a passkey requires a successful passkey verification within
  the last five minutes. List credential labels and last-use times in settings.
  Serialize credential changes for the owner. Normal removal cannot delete the
  last active passkey. Offer enrollment of a second passkey after setup.
- If all passkeys are lost, run `npm run admin -- auth recover` from the
  deployment console. It preserves the owner identifier and mail. It revokes
  existing credentials, sessions, challenges, and grants, then issues a replacement
  grant under the same token rules. That grant permits registration only.
  Browser access resumes after the new passkey is registered. An expired grant
  can be replaced from the console; public requests cannot start recovery.
- Record bootstrap, credential changes, and recovery as events without secrets.
  Sessions and challenges are bound to the recovery generation. Restoring a
  backup also requires the credential recovery step in section 10. Auth recovery
  alone never releases held mail actions or changes the mail recovery generation.

## 10. Deployment (Coolify)

1. One multi-stage Docker image. The Fastify process serves the API and
   runs the pg-boss worker inline.
2. Postgres runs as a Coolify resource. The app receives `DATABASE_URL`.
3. The entrypoint runs `drizzle-kit migrate`, then starts the server on
   port 3000. Coolify's proxy terminates TLS.
4. Health check: `GET /api/healthz` verifies a database round trip and
   reports sync lag and classification status.
5. Volumes: persist PostgreSQL and durable originals, uploads, and outbound
   MIME files. Only extracted attachment copies and derived caches are lossy.
6. Backups: copy the database and durable objects off-box nightly. Use a
   consistent database snapshot, then copy every object it references while
   garbage collection is paused. Verify hashes and rehearse a full restore.
7. Environment: `DATABASE_URL`, `CREDENTIALS_KEY`, `TYPE_SAFE_API_KEY`
   (optional), `BASE_URL`, and `RECOVERY_GENERATION`. Generate a random UUID
   (universally unique identifier) for the recovery generation at installation.
   Keep it across ordinary restarts and releases. Set a new value for every
   restore; never recover its current value from the database or backup bundle.

Resource sizing: 2 GB RAM instance. One IMAP connection per account during
backfill. Stream originals to disk and bound parsing concurrency. Monitor
free disk space; pause imports and uploads before durable writes become unsafe.

**Restore procedure**

This procedure is required for every restore. Startup cannot detect a rollback
if the operator reuses the previous recovery generation outside the database.

1. Stop the API and all workers before restoring. Ensure the old process cannot
   continue a remote operation. Preserve available receipts newer than the backup.
2. Restore the database and durable objects. Verify their hashes. Set a new
   `RECOVERY_GENERATION` in deployment configuration before starting the app.
   Missing configuration or a generation mismatch keeps workers and mail mutations
   blocked. A database restore alone must never enable normal operation.
3. Run `npm run admin -- recovery begin`. It records the new generation and
   mode `reconciling`, disables old jobs, and revokes restored sessions, grants,
   challenges, and credentials. Repeating this command for the same active
   recovery resumes it without repeating credential revocation. It rejects the
   current generation when the service is already `ready`.
4. Reconcile restored pending sends against newer durable responses and server
   evidence. A restored `queued` row may already have been sent. Hold unresolved
   sends as `outcome_unknown`. Reconcile potentially completed Sent appends
   separately; keep unresolved append outcomes `unknown`.
5. Mark old queued management actions conflicted. Reconcile executing actions
   without replaying them; preserve unknown outcomes where evidence is insufficient.
   Never replace an old job's generation. Requests absent from the backup receive
   the same protection through the generation check described below.
6. Run `npm run admin -- auth recover` and register a replacement passkey.
   This prevents the backup from restoring access through a previously revoked
   credential. Verify the owner can sign in and inspect held operations.
7. Run `npm run admin -- recovery complete`. It requires a registered owner,
   the matching deployment generation, and disposition of all restored pending
   operations. Confirmed results and explicitly held unknown outcomes both qualify.
   It sets mode `ready` for new work. Old jobs remain disabled; sync reconciles
   server state before accepting new occurrence actions.

Every durable client mutation carries the generation captured when it was created.
Authenticated sessions expose the current generation for new work. Check request
generations before idempotency lookup, even when the key is absent from the
database. Return `409 recovery_required` on a mismatch. For a matching generation,
return `503 recovery_in_progress` until control state matches deployment and
mode is `ready`. Enrollment and operator recovery remain available. Normal
passkey login is blocked while control state differs from deployment. During
`reconciling`, only replacement credentials can open an inspection session.
The client preserves the original generation on cached drafts, uploads, and
queued actions. A fresh login must not silently reauthorize those requests.

For example, a send can be created and accepted after the backup while its
acknowledgement to the device is lost. Restoring that backup removes its key.
The old generation still blocks the device's replay, even after normal service
resumes. An explicit resend requires review, a duplicate warning, a new key,
and a snapshot under the current generation. Empty Sent results are insufficient
evidence to permit an automatic resend.

## 11. Observability

- `events` is the audit trail: sync milestones, flag changes, sends,
  corrections, classifier pauses.
- `GET /api/healthz`: database round trip, sync lag per account, oldest
  queued job, classification circuit state, and recovery mode.
- Track per account: messages synced, bodies fetched, last full
  reconciliation, Jev calls, Jev error count.
- Weekly review of: sync lag, send failures, `outcome_unknown` count,
  classification coverage.

## 12. Testing and validation

**Fake mailbox harness**

A local IMAP test server with scripted conversations: duplicate
notifications, expunged messages, `UIDVALIDITY` changes, malicious HTML,
oversized attachments, interrupted sends, and expired sessions. No real
credentials in tests or agent development.

**Transport and authentication acceptance**

- Verify IMAP over implicit TLS, SMTP with required STARTTLS, and SMTP over
  implicit TLS. Each connection test reports its result without sending a message.
- Omit STARTTLS, fail its negotiation, and present expired or mismatched
  certificates. Assert that neither protocol sends authentication credentials
  or mail content before a verified encrypted connection exists.
- Start with an empty database and register the owner through the console
  bootstrap grant. Reject public enrollment, expired tokens, reused challenges,
  incorrect origins, and incorrect relying party identifiers.
- Race two first-passkey registrations. Exactly one consumes the grant and
  creates the owner. Verify the other attempt cannot create a second credential.
- Add a second passkey, revoke one, and attempt removal of the last active
  passkey. Require recent verification and preserve one active credential.
  Repeat concurrent revocations to verify the rule holds within a transaction.
- Lose all passkeys and recover from the deployment console. Verify that old
  credentials and sessions fail, expired recovery grants grant no access, and
  the replacement credential opens the same mail without releasing held sends.

**Defuddle corpus**

Ten to twenty redacted real emails as fixtures: Outlook reply chains, Gmail
quoting, a newsletter, a calendar invite, a table-wrapped one-liner.
Snapshot tests pin the Markdown output. Include empty extraction and plain-text
fallback. Verify no remote requests occur during extraction or preview without
explicit image loading, and no removed message text enters diagnostic logs.

**Sync, storage, and search acceptance**

- Interrupt newest-first backfill between batches. Resume without gaps while
  new arrivals continue. Include empty UID ranges and an empty folder.
- Copy one message into two folders. Preserve both occurrences and independent
  flags. Missing or reused `Message-ID` headers never lose content.
- Import a three-message conversation newest first. Resume after a restart;
  all unique parent links converge into one thread in that account.
  Deliver a missing parent after backfill and verify the same relinking behavior.
- Resolve ambiguity after byte-identical messages merge. Then introduce a
  different message with the same header identifier and remove the unsafe link.
  Multiple parents, cycles, and cross-account copies never create guessed links.
- Change `UIDVALIDITY`, reuse a UID, and reconnect an offline device. Reject
  the old action before any remote write. Discard stale worker results.
- Test concurrent flag changes with and without conditional-write support.
  Preserve unrelated flags and expose conflicts and pending actions.
- Find a header-only message by sender, recipient, and subject before fetching
  its body. After fetching, find body terms and mixed header/body queries.
- Restore the database and durable files together. Verify original hashes,
  draft uploads, and queued MIME bytes. Regenerate sanitized views and caches.
- Store two attachments with identical names, types, and decoded sizes but
  different bytes. Delete their extracted copies and regenerate by attachment ID.
  Verify exact hashes and stable IDs, including nested `message/rfc822` parts.
  Duplicate Content-ID values must not select an arbitrary inline image.
- Repeat attachment parsing and logical message merging. Preserve part rows
  without duplicate IDs. Reject unsupported locators and changed decoded bytes.
- Edit a draft from two devices. Reject the stale revision. Delete a draft
  after sending fails; retain files referenced by its outbound snapshot.

**Reply acceptance**

- Reply to a message whose `Reply-To` differs from `From`. Verify the default
  recipients. An absent header uses From; an invalid header requires correction.
- Reply all across To/Cc lists containing duplicates and configured identities.
  Verify that no Bcc address is copied. Reply to your own sent message and
  retain its visible recipients instead of addressing the reply to yourself.
- Reply to a grouped copy held in two accounts. Require an account choice.
  Test one matching alias, several matching aliases, and a blind copy without
  a match. Verify the chosen account and From identity in the wire message.
- Inspect outgoing `In-Reply-To` and `References` across a three-message chain.
  Cover missing identifiers and the single-parent fallback. Relink a thread
  after queueing; the stored headers and submitted bytes must remain unchanged.
- Verify that text-only and extraction-failure replies produce readable quoted
  text without literal HTML tags. With attachments, verify both body alternatives
  and every file survive parsing of the generated MIME message.

**Send safety**

Use a scripted SMTP server as well as the IMAP harness. Count SMTP submissions
and Sent copies independently. Include these cases:

- Repeat the same queue request, including concurrent requests. Create one
  snapshot and at most one automatic SMTP submission. Reject changed payloads
  under the same key.
- Crash before submission, during submission, and after acceptance but before
  the database commit. Abandoned `sending` rows become unknown without replay.
- Drop the final SMTP response after accepting the message. An empty Sent
  folder must not authorize another send.
- Reject all recipients, then reject only some recipients. Report exact
  outcomes; never retry accepted recipients with a partial retry.
- Fail Sent append after confirmed SMTP acceptance. Keep `sent`; retry only
  the append when safe. A lost append response enters reconciliation.
- Before the first append attempt, find the accepted message by a unique body
  term in All Mail, search, Sent, and its conversation. Repeat with append
  pending, failed, and unknown. Show partial acceptance without inventing flags.
- Import the eventual Sent copy, including an import racing acceptance handling.
  Match the original hash and retain one local message with its occurrence.
  Repeated acceptance and append jobs do not duplicate search results.
  A different body with the same `Message-ID` remains separate.
- Confirm that definitive send failure and an unknown outcome do not create a
  local accepted message. When newer durable evidence resolves an unknown send,
  commit its sent state, local index, and append job together.
- Change the account's default identity after queueing and attempt a draft
  edit. Reject the edit. Verify the stored From, envelope, headers, attachments,
  and MIME bytes remain unchanged.
- Restore a backup containing queued sends that completed afterward. Keep
  outbound workers paused until reconciliation; do not automatically resend.
- Create and accept a send after the backup, then lose its queue acknowledgement
  to the device. Restore the earlier database where its key does not exist.
  Reauthenticate, then replay the device request during recovery and after
  normal service resumes.
  Both return `recovery_required`, with zero additional SMTP submissions.
- Reauthenticate after a restore. Preserve the generation on pending sends,
  uploads, and draft changes. Never replace it automatically or lose local data.
  Require explicit review before rebasing changes or deliberately resending.
- Start with missing or mismatched recovery configuration. Verify that workers
  and mail mutations remain blocked. Old jobs remain disabled after completion.
  Retry the operator recovery commands; they must preserve progress and outcomes.
- Restore a backup with a credential that was revoked afterward. Verify that
  restored credentials and sessions cannot grant access, including before
  `recovery begin` runs. Complete credential recovery before reopening normal
  work under the new generation.

**Jev evaluation gate**

1. Hand-label 100–200 of your own messages. Include forwarded chains,
   bilingual mail, and mixed receipt-plus-question mail.
2. Run `npm run eval:classify` against stored decisions.
3. Measure: critical false negatives (personal or action mail bundled into
   Reading or Notifications), coverage (share answered without error), and
   correction rate per sender.
4. Enable routing only when critical false negatives are zero in the
   labeled set. Until then, shadow mode.

**Interface acceptance**

- Complete Inbox triage, search, reply, and send with the keyboard alone.
  Repeat with a screen reader. Verify focus after archive, move, and errors.
- Open the palette from the list and editor. Verify one activation per key
  event, correct platform labels, nested choices, empty results, and focus return.
- Verify that single-key commands never trigger while typing or composing text.
  Confirm the shortcut-disable setting and visible touch alternatives.
- Run core flows on a Mac and a real iPhone. Verify keyboard focus on macOS,
  touch controls, safe areas, the software keyboard, and installed PWA behavior.
  Compact mode must preserve readable text and 44px touch targets.
- Run the core flows in light, dark, reduced-motion, offline, and slow-network
  conditions. Check pending and failure states, not just successful interactions.
- Review the shell, palette, message rows, and compose controls at 320px,
  768px, and 1440px widths, plus 200% text zoom. Check long subjects and addresses.
- Measure palette input focus and local feedback at under 100ms at the 95th
  percentile on a documented reference device. Test with 100k stored messages
  and a bounded rendered list. Palette opening must cause no network request.
- Include visual regression checks for shared components and the main flows.
  Review real browser recordings for animation, focus, and scroll stability.

**Definition of done for any change**

Strict type check passes. Integration tests pass. Browser workflow passes.
Migrations apply cleanly. Relevant action-service permission checks pass.
Interface changes also pass the relevant F11/F12 checks, including reduced motion.

## 13. Cost budget

| Item | Estimate |
| --- | --- |
| VPS (virtual private server), 2 GB | €6–15 per month |
| Postgres | Included in VPS or Coolify resource |
| Jev steady state, 300 messages per day | Roughly $0.76 per month |
| Jev historical backfill, 50,000 messages (optional) | Roughly $4.20 one time |

The Jev estimates use the vendor-reported rate in `research/research.md`: $0.042 per
million input tokens. Assume 2,000 billed input tokens per call, one call per
message, and 30 days per month. Retries and repeated classification add cost.
The dependency risk outweighs the token cost.

## 14. Milestones

Each milestone has a testable acceptance gate. Week numbers are planning
estimates. Do not defer send recovery or identifier checks to week 6.

| Week | Deliverable | Acceptance |
| --- | --- | --- |
| 1 | Secure setup and sync | Passkey enrollment and recovery, verified mail transport, resumable backfill, thread relinking, and durable originals pass the harness. |
| 2 | Reading and management | Shared visual system, unified reader, command palette, two-way flags, and core microinteractions. |
| 3 | Search | FTS plus operators across all accounts, under 500 ms p95 at 100k messages. |
| 4 | Compose and send | Reply addressing and headers, immutable snapshots, immediate sent indexing, separate Sent append, and recovery generation checks pass acceptance. |
| 5 | Jev shadow mode | Classify job, decisions table, visible suggestions, eval script. |
| 6 | Hardening | Full restore with device replay rehearsed, attachment caches regenerated, offline conflicts tested, and clean view verified. |

Phase 2 (later): work states on `conversation_state`, rules with shadow
mode and replay, agent actions through the action service.

## 15. Risks

| Risk | Mitigation |
| --- | --- |
| IMAP quirks on PurelyMail (IDLE unconfirmed) | Poll-first design; IDLE is an opt-in upgrade. |
| Defuddle heuristics built for articles, not mail | Derived-only output; fallback path; corpus snapshots. |
| Jev is days into early access | Adapter interface, pinned version, circuit breaker, shadow mode gate. |
| Large backfill memory pressure | One connection per account; UID-range batching; headers first. |
| Coolify host is a single point of failure | Off-box backups; rehearsed restore; mail remains on PurelyMail regardless. |
| Storage growth | Stream durable originals; cache extracted attachments on demand; review retention after 100k messages. |

PurelyMail retains its mailbox copies. Local drafts, uploads, and pending
sends depend on app storage and backups. Messages removed from the server
remain recoverable only if their originals were fetched and retained locally.

## 16. Deferred decisions

- Work-state views: phase 2. Classification bundles remain in this version.
- Rules engine and natural-language filters: phase 2.
- Agent approvals and actions: phase 2, on the action service.
- Notifications strategy: after real usage shows the need.
- FTS language configuration: `simple` now; reindex if stemming proves
  worth it.

## 17. References

- `research/research-3.md` — stack, sync reliability, offline, deployment costs.
- `research/modern-email-report-pdf.md` — state separation, calm attention,
  honest states, agent guardrails.
- `research/research.md` — Jev capabilities, limits, validation method.
- `research/research-2.md` — not used for this MVP; it covers consumer pricing.
- [PurelyMail](https://purelymail.com) — protocol and pricing inputs.
- [Defuddle](https://github.com/kepano/defuddle) — extraction library.
- [SMTP timeout semantics](https://www.rfc-editor.org/rfc/rfc5321.html#section-4.5.3.2.6) — acceptance ambiguity.
- [Reply addressing and references](https://www.rfc-editor.org/rfc/rfc5322.html#section-3.6.2) — recipient defaults and reply identifiers.
- [Nodemailer TLS options](https://nodemailer.com/smtp#tls-options) — required encryption for submission.
- [ImapFlow connection options](https://imapflow.com/docs/api/imapflow-client/) — encrypted mailbox connections.
- [WebAuthn verification](https://www.w3.org/TR/webauthn-3/#sctn-rp-operations) — passkey registration and authentication.
- [IMAP identifiers](https://www.rfc-editor.org/rfc/rfc9051.html#section-2.3.1.1) — folder generations and UID identity.
- [Conditional flag updates](https://www.rfc-editor.org/rfc/rfc7162.html) — CONDSTORE and reconciliation.
- [shadcn/ui components](https://ui.shadcn.com/docs/components) — shared component source and primitives.
- [shadcn/ui command](https://ui.shadcn.com/docs/components/radix/command) — command palette built with cmdk.
- [Motion accessibility](https://motion.dev/docs/react-accessibility) — reduced-motion support.
