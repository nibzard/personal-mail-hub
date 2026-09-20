# Sync repair plan

Date: 2026-09-20
Status: planned
Tasks: T104–T107 in [to-do.json](../to-do.json)

## Evidence and scope

The deployment review found two folders that repeatedly fail during import:
`Trash` and `Deleted Messages`. PostgreSQL reports
`invalid byte sequence for encoding "UTF8": 0x00` during a message insert.
The exact source field is not yet identified. Do not assume it is the subject.

The sync runner contains each failure and continues other work. Its
`failureText` helper returns arbitrary error messages. Database errors can
include query parameters with private mail data. Folder names also reach logs.

At 21:40 UTC, the deployment reported 6,418 messages and 5,527 pending bodies.
Two folders still needed backfill. The health report showed `ok` and a recent
cycle despite repeated folder failures. A recent cycle does not prove that
all folders progressed.

Sending and Sent-copy storage succeeded. Classification resumed with 221
successful calls and no new errors. These flows need regression checks but
no redesign for this incident. Pending bodies alone are normal during import.

This plan follows SPEC F2, F5, sections 8–12, and the product requirement to
show the true synchronization state. Original mail remains the record.

## T104: Remove private data from sync diagnostics

Priority: 1. No dependencies.

1. Replace `failureText` with an explicit allowlist of failure kinds.
2. Cover folder, body, thread, and outer worker failures. Do not serialize
   unknown errors, nested causes, messages, stacks, or database parameters.
3. Log only operation, internal identifiers, and an approved error code.
   Remove folder names, mail identifiers from headers, addresses, and content.
4. Record safe diagnostic fields with durable sync status or failure events.
   Preserve the existing containment behavior and per-cycle error counters.
5. Add regression tests with nested database errors, arbitrary thrown values,
   and sentinel secrets. Assert that logs and events never contain sentinels.
6. Review affected worker logs and retention without copying raw entries into
   commits, task files, or reports. Record scope using counts and timestamps.
   Do not delete existing audit history as part of the code fix.

Acceptance: every contained failure remains diagnosable by operation and safe
code. No synthetic private value reaches any tested log or event. Tests must
fail against the current implementation.

Likely files: `packages/sync/src/runner.ts`, `packages/sync/src/errors.ts`,
`apps/worker/src/main.ts`, and their tests.

## T105: Make imported text safe for PostgreSQL

Priority: 1. Depends on T104 for safe diagnosis and deployment.

1. Trace parsed values from header import and complete-message ingestion to
   database text and JSON fields. Identify the failing field with names,
   types, and counts only. Reproduce the failure with synthetic mail.
2. Define one policy for NUL characters at the derived-data boundary.
   Replace NUL in display text with the Unicode replacement character.
   Apply the policy to nested display strings and indexed derivatives too.
3. Handle identifiers and addresses through their existing validation rules.
   Never remove a byte and turn an invalid address or identifier into a valid
   one. Preserve malformed-header indicators and required recipient review.
4. Cover subject, names, recipients, reply headers, thread references, body
   derivatives, and attachment metadata where these reach text or JSON.
   Keep valid Unicode unchanged. Do not apply a generic rewrite to all values.
5. Preserve original message bytes, attachment bytes, hashes, and stored
   locators. Sanitizing derived text must not alter provider mail or originals.
6. Add PostgreSQL integration cases for raw and decoded NUL characters,
   nested metadata, and body ingestion. Cover backfill and new arrivals.
7. Prove that a failed batch leaves its checkpoint unchanged. After repair,
   retry the same batch and prove complete import without duplicate rows,
   lost occurrences, incorrect thread links, or repeated body work.

Acceptance: synthetic messages that previously fail now persist through both
header and body ingestion. Stored originals and attachments retain their
hashes. Existing checkpoints resume without resetting the account or skipping
messages. Valid messages preserve their current behavior.

Do not broaden this task into arbitrary data repair. If a value cannot be
represented safely under the chosen policy, retain the checkpoint and report
a safe failure. Do not silently discard that message to advance the folder.

Likely files: `packages/sync/src/headers.ts`, `packages/sync/src/store.ts`,
`packages/ingestion/src/parse.ts`, `packages/ingestion/src/text.ts`,
`packages/ingestion/src/service.ts`, and PostgreSQL integration tests.

## T106: Show partial sync failures in status

Priority: 2. Depends on T104.

1. Read the durable folder, body, and thread error counters from the latest
   account cycle. Include safe failure codes when available.
2. Extend the shared health and sync status contracts with per-account sync
   state. Distinguish progressing backfill, partial failure, and stale cycles.
3. Show degraded sync when the latest cycle contains errors, even when the
   cycle is recent. A later clean cycle clears that state. Missing historical
   fields mean unknown, not proven healthy.
4. Keep the health query read-only and bounded. Preserve its database query
   budget. Do not expose mail text or folder names in the public report.
5. Show the state in account settings with clear progress and failure text.
   Keep database availability separate from mailbox progress. Preserve the
   existing HTTP liveness behavior so partial sync does not cause restarts.
6. Test one failed folder beside a healthy folder, normal backfill, stale
   status, old status records, and recovery after a clean cycle. Test the
   API contract and the visible settings state.

Acceptance: repeated contained failures cannot appear as healthy sync solely
because the worker emitted a recent status event. Normal pending bodies do
not imply a failure. Error detail remains safe in every response.

Likely files: `packages/observability/src/health.ts`,
`packages/contracts/src/index.ts`, `apps/api/src/settings-routes.ts`,
`apps/web/src/components/settings/account-settings.tsx`, and related tests.

## T107: Deploy and verify resumed synchronization

Priority: 2. Depends on T104, T105, and T106.

1. Run `npm run check` and `npm test` with `TEST_DATABASE_URL` set. Run
   `npm run release:gate -- --strict` against a scratch database. Every
   required suite must run. Use a free browser fixture port.
2. Record safe baseline counts, folder checkpoints, body backlog, error
   counters, and container health. Record no message content or credentials.
3. Commit the fixes and push to `main`. The configured GitHub webhook starts
   Coolify automatically. Confirm the deployed revision before verification;
   do not queue a second deployment while the webhook deployment runs.
4. Observe both affected folders advancing from their existing checkpoints.
   Continue until their backfill completes. Verify no NUL insert errors,
   duplicate occurrences, or new sync errors across at least three cycles.
5. Confirm body fetch progress. Keep this task open until the body backlog
   drains to the expected steady-state level, or record a concrete blocker.
   Identify explicit oversized-message skips separately from failures.
6. Verify passkey and account records remain present, classification works,
   and existing send and Sent-copy outcomes remain correct. Do not send new
   mail, change flags, move mail, or reset recovery state for this check.
7. Save a sanitized verification note with revision, timestamps, counts, and
   remaining limits. Mark tasks done only after their acceptance checks pass.

If rollout fails, use Coolify to restore the last working image. Preserve
storage, database state, credential keys, and recovery generation. Rolling
back restores service availability; it does not fix the earlier import bug.

## Completion criteria

All four tasks must pass their acceptance checks. Source mail and stored
originals remain intact. Both folders finish backfill. Subsequent sync cycles
remain free of the incident errors. Health and settings report the actual
sync state, and diagnostics contain no private mail data.
