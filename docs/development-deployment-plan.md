# Development and deployment feedback plan

Date: 2026-09-20
Status: planned
Task list: [to-do.json](../to-do.json)
Incident plan: [Sync repair plan](sync-repair-plan.md)

## Objective

Shorten the time from a change to trustworthy evidence that it works.
Verify mail progress as well as service availability. Keep private mail and
credentials out of diagnostics, fixtures, and reports.

This plan covers every lesson and source of friction from the deployment
review. T104–T107 remain the incident tasks. T108–T117 add the preventive
work. This document does not authorize implementation or change deployment
settings by itself.

## Existing work and execution order

| Stage | Tasks | Result |
| --- | --- | --- |
| Repair the incident | T104, T105, T106, T107 | Safe logs, complete imports, truthful status, verified rollout. |
| Improve feedback | T108, T109, T110, T111, T112 | Contract checks, realistic fixtures, known access, one verification command, isolated browser runs. |
| Remove tooling friction | T113, T114, T115 | Repeatable builds, valid tasks, visible gate progress. |
| Protect deployment | T116, T117 | Checks before main, auditable webhook delivery, verified installed revision. |

Follow task dependencies rather than treating each stage as a global barrier.
T107 must not wait for all preventive tooling to ship. Perform its checks
manually until T111 exists. Prioritize T104 first because current diagnostics
can contain private data.

Already completed: the TypeSafe adapter repair, dedicated SSH access, and a
signed GitHub webhook that successfully triggered a deployment. Do not repeat
these setup changes or rotate working credentials without a specific need.
The task schema now accepts existing metadata; its automated checks remain
planned. Session findings are dated evidence, not perpetual health claims.

## Standard feedback loop

1. Reproduce the issue with a focused synthetic regression test.
2. Run focused tests and type checks while editing. Check external contracts
   when the integration changes, using an explicit synthetic live request.
3. Validate the final tree with the strict release gate and task validation.
4. Merge the verified change into main through the required checks. Let the
   existing webhook start the deployment.
5. Correlate the delivery, deployment, and installed commit. Compare safe
   workflow metrics before and after rollout.
6. Report verified workflows, progressing work, known failures, and untested
   behavior separately. Include the observation time and deployed revision.

A working health endpoint does not prove complete synchronization. A
registered passkey does not prove a new login ceremony. SMTP acceptance and
a stored Sent copy do not prove delivery to the recipient. State only what
the evidence establishes.

## Work items

## T108: Verify external API contracts with synthetic requests

Priority: 2. Dependencies: none.

The original tests accepted an incorrect TypeSafe endpoint and response shape. The adapter is fixed; this task prevents recurrence.

1. Keep offline contract fixtures traceable to official documentation and a reviewed model version. Cover endpoint, authentication, request shape, typed answers, and error responses.
2. Add an explicit synthetic smoke command that calls the adapter with invented text. Resolve the API key from the runtime environment and print only approved result fields.
3. Set request timeouts and a small call budget. Keep live requests out of default tests and untrusted pull requests. Missing credentials produce an explicit unverified result.
4. Run the smoke check when the adapter, question set, model, or endpoint changes. Verify the installed adapter after deployment.

Acceptance: A deliberately incorrect endpoint or response fixture fails offline checks. An authorized synthetic live check verifies the configured service without real mail, secret output, or database mutations.

Likely locations: `packages/classification/src/adapter.ts`, `packages/classification/test/adapter.test.ts`.

## T109: Expand synthetic malformed-mail regression coverage

Priority: 2. Dependencies: T105.

The NUL-byte incident showed that clean fixtures omit important incoming-mail cases. T105 owns the incident fix and its essential regression tests.

1. Extend the shared synthetic corpus with raw and decoded NUL characters, missing or malformed headers, folded references, nested address metadata, and attachment metadata.
2. Exercise header import, complete-message ingestion, search derivatives, and thread reconciliation through their real boundaries. Use PostgreSQL for database representation cases.
3. Check valid Unicode, original and attachment hashes, retry idempotency, and checkpoint atomicity. Assert that each malformed case either imports safely or reports a contained failure.
4. Document how to reduce a future incident into a synthetic fixture. Never commit raw provider mail or extract private log parameters as fixtures.

Acceptance: The corpus detects the known NUL regression and unsafe normalization of addresses or identifiers. Tests prove that adjacent valid mail progresses without silent message loss.

Likely locations: `packages/harness`, `packages/sync/test`, `packages/ingestion/test`.

## T110: Document and preflight deployment access

Priority: 2. Dependencies: none.

SSH access required host verification and a dedicated authorized key during diagnosis. A local identity path must remain configurable.

1. Document the application URL, Coolify resource identifier, repository, main branch, compose path, SSH user, and tailnet host in the operator runbook.
2. Document the dedicated SSH identity override, host-key verification, public-key enrollment, rotation, and revocation. Store no private key or token in the repository.
3. Add a read-only operator access check, separate from the container environment preflight. Distinguish unavailable tailnet routing, host-key mismatch, denied SSH, and unavailable Docker or Coolify access.
4. Allow a configured Coolify API token when available. Report missing capabilities clearly; never dump environment variables or generate new credentials silently.

Acceptance: A fresh authorized workstation can follow the runbook and confirm required access with one command. Failure output identifies the missing capability without exposing credentials.

Likely locations: `deploy/README.md`, `deploy/preflight.mjs`.

## T111: Add one command for deployment verification

Priority: 2. Dependencies: T104, T106, T110.

Manual health queries, container inspection, and database checks made verification slow. Container health alone missed the stalled folders.

1. Add a read-only command that resolves the current application containers and deployed revision from the configured resource. Avoid hard-coded container suffixes.
2. Report deployment state, revision, restarts, recovery readiness, safe sync failures, per-folder checkpoints, body backlog, classification progress, and existing send outcomes.
3. Support bounded before-and-after sampling. Evaluate progress only when work is pending; an idle mailbox is not a failure. Separate normal backlog from a stalled or failing operation.
4. Use safe API fields or narrow aggregate database queries. Never print raw logs, addresses, folder names, message content, or secrets. Handle partial access as unverified.
5. Produce both a machine-readable result and a short report with verified workflows, progressing work, known failures, and untested behavior. Include timestamps and revision.
6. Test wrong revisions, partial folder failures, clean idle accounts, unavailable containers, missing privileges, and observation timeouts. Do not send or mutate mail to verify a deployment.

Acceptance: One command can reject a healthy-container deployment with broken sync. It records bounded evidence, states uncertainty, and never reports a fully verified result when required checks were unavailable.

Likely locations: `scripts`, `deploy/README.md`, `packages/observability/src/health.ts`.

## T112: Isolate browser fixtures for every test run

Priority: 2. Dependencies: none.

Local browser tests could reuse a stale server on port 4180. A manually chosen free port worked, but needs automation.

1. Give each browser run its own fixture server, port, and ownership token. Verify a build fingerprint and run identity before tests start.
2. Handle port allocation races with bounded retries. Preserve E2E_PORT as an explicit override and report collisions clearly.
3. Prevent concurrent runs from overwriting shared build output. Use an isolated output directory or an explicit build lock.
4. Terminate only the server owned by the run on success, failure, and interruption. Keep traces for failures.
5. Verify behavior with a stale unrelated server on 4180 and with two concurrent runs. Keep release checks from silently reusing any existing server.

Acceptance: Both concurrent runs test their intended build without shared-server contamination. The unrelated server survives, and failed startup cannot produce a passing result.

Likely locations: `apps/web/playwright.config.ts`, `apps/web/e2e/fixture-server.mjs`, `scripts/release-gate.mjs`.

## T113: Diagnose and document Docker build networking

Priority: 3. Dependencies: T110.

A local build failed DNS resolution on the default Docker network. Host networking succeeded locally; the cause and portability remain unverified.

1. Compare host and build-container DNS, registry access, proxy configuration, and BuildKit networking using commands that expose no credentials.
2. Record whether the failure affects only the developer host or also the Coolify builder. Test each supported environment independently.
3. Correct the verified configuration fault at the narrowest scope. Document the host-network workaround and its limits; do not make it an unconditional build default.
4. Build both app and web targets with the chosen configuration. Retain exact reproduction commands and safe failure categories.

Acceptance: The root cause is documented with evidence, or explicitly remains unresolved with a verified workaround. Supported builds resolve dependencies without manual trial and error.

Likely locations: `Dockerfile`, `deploy/README.md`, `deploy/docker-compose.coolify.yml`.

## T114: Validate task files automatically

Priority: 3. Dependencies: none.

The task file contained metadata that its schema rejected. Optional updated_at and notes definitions were added during planning; automated validation is still missing.

1. Add a repeatable task-validation command using the repository schema and date-time formats. Declare validator dependencies directly if needed.
2. Reject duplicate task identifiers, missing dependencies, self-dependencies, dependency cycles, and missing source documents.
3. Validate plan links and section anchors for planned work. Distinguish intended future implementation files from existing source documents, so planned files are not rejected.
4. Run the command when task files, schema, or referenced plans change. Add focused fixtures for invalid records, broken plan links, and cycles.

Acceptance: A clean checkout validates the current task list. Each malformed fixture fails with a precise task identifier or field path, while historical notes and planned future files remain supported.

Likely locations: `to-do.json`, `to-do.schema.json`, `package.json`, `scripts`.

## T115: Stream release-gate progress and retain logs

Priority: 3. Dependencies: none.

The gate captures output through spawnSync and prints it only after a step finishes. Long steps appear inactive and complicate diagnosis.

1. Run each gate step with asynchronous process handling. Stream progress and persist complete stdout and stderr without buffering unbounded output in memory.
2. Keep the exit code authoritative. Preserve the current test-inventory, skipped-suite, migration, and strict-mode checks.
3. Show elapsed time and a periodic heartbeat for quiet steps. Implement configurable timeouts and interrupt cleanup for the owned process tree.
4. Retain failed logs and a concise final summary. Never print environment variables or add commands that echo credentials.
5. Test slow output, silent steps, nonzero exit after a passing-looking summary, timeout, signal interruption, and large output.

Acceptance: A long-running check shows progress at least every 30 seconds. Failed or skipped checks cannot pass because of output text, and interrupted children do not remain running.

Likely locations: `scripts/release-gate.mjs`.

## T116: Gate main before automatic deployment

Priority: 2. Dependencies: T112, T114, T115.

Pushes to main now deploy immediately. Checks that start only after that push cannot prevent an unverified deployment.

1. Document a fast local loop: focused regression tests and affected workspace type checks first, then the full required checks before integration. Use a conservative full-run fallback when impact is unclear.
2. Add a continuous integration workflow for pull requests with a scratch PostgreSQL service, browser dependencies, task validation, and the strict release gate. Cache dependencies using the lockfile.
3. Require the successful check before merging into main through repository rules supported by this repository. Record any plan or permission restriction as a blocker.
4. Keep the main-push webhook as the deployment trigger after the verified merge. Do not treat a local hook as the only protection or expose deployment secrets to untrusted code.
5. Check merge-result coverage and current-branch requirements so an outdated successful check cannot authorize a different final tree. Document explicit emergency bypass handling.
6. Measure focused-check and full-gate durations before and after the changes. Optimize repeated setup without removing required suites.

Acceptance: A failing or outdated pull-request check prevents ordinary integration into main. A verified merge deploys once. Fast local checks remain convenient, while release validation remains complete.

Likely locations: `package.json`, `scripts/release-gate.mjs`, `deploy/README.md`.

## T117: Verify and document the webhook deployment path

Priority: 2. Dependencies: T110, T111.

The signed GitHub push webhook is already configured and tested. This task makes its verification and maintenance repeatable rather than recreating it.

1. Document the current main-branch deployment path, secret ownership, rotation procedure, and location of GitHub delivery and Coolify deployment records.
2. Add a read-only configuration audit for webhook activity, push subscription, destination, signature-secret presence, main branch selection, and auto-deploy setting. Never display the secret.
3. Provide an explicit end-to-end test mode that replays a selected GitHub delivery or uses the supported test endpoint. Identify the commit and warn that this mode starts a deployment.
4. Correlate delivery outcome, Coolify deployment, installed revision, and verification results. Do not queue a manual deployment while the webhook deployment is running.
5. Test invalid signatures, other branches, delivery failure, missing webhook configuration, and duplicate delivery behavior in an isolated setup. Use the live test only during an authorized deployment window.

Acceptance: The audit distinguishes an enabled switch from a working webhook. An explicit signed test can prove the path through a finished deployment and matching revision, with no duplicate manual rollout.

Likely locations: `deploy/README.md`, `scripts`.

## Completion and evidence

Keep each task in `todo` until implementation starts. Record focused and full
validation results when the task finishes. Infrastructure tasks need evidence
from the intended environment; local mocks alone cannot complete them.

Record baseline and final durations for the focused loop, release gate,
deployment, and post-deployment diagnosis. Set numerical improvement targets
after the baseline exists. Do not trade test coverage or privacy for speed.

The final exercise uses a small reviewed change to prove the complete loop:
required checks, verified merge, one webhook deployment, correct revision,
useful progress checks, and a report that labels remaining uncertainty. Keep
all evidence free of secrets and private mail. Record unresolved access or
platform restrictions as blockers rather than silently bypassing checks.
