# Home screen implementation plan

- Date: 2026-09-20
- Status: Direction agreed; implementation pending
- Scope: Optional Home screen with important mail, explicit commitments, and reminders

## Purpose

Help you identify important mail and finish follow-ups across all accounts.
Home combines your explicit choices with suggestions from stored Jev answers.
Core mail remains available when classification is disabled, paused, or unavailable.

## Agreed product decisions

- Home is the default entry after sign-in. A setting lets you start in Inbox instead.
- Home remains available in navigation when the startup setting is off.
- Your priority choices take precedence over Jev ranking.
- Reading, archiving, and completing work remain separate actions.
- Jev suggests attention. Only you create a commitment to reply or a reminder.
- Home uses existing themes, density settings, components, and keyboard conventions.
- Home provides the same core functions on desktop and mobile.
- Mail remains accessible through Inbox, All Mail, and search.

## Scope change

`SPEC.md` currently defers commitment tracking and work states to phase 2.
This plan brings a limited subset into the Home release:

- Reply later commitments.
- Reminders with dates you choose.
- Explicit completion and reopening of saved work.

Update the specification before implementation. Keep broader task management,
agent actions, and calendar integration deferred.

The reserved `conversation_state` table has no active readers today.
Its existence does not mean that reminders or work states already function.

## First release

| Capability | Behavior |
| --- | --- |
| Startup preference | Add **Show Home when the app opens**, enabled by default. |
| Priority | Let you prioritize a sender or thread independently of its message category. |
| Reply later | Save an intention to answer without requiring a date. |
| Reminders | Return mail at a date and time you choose. |
| Since your last visit | Show new arrivals separately from older unresolved work. |
| Saved reference mail | Reuse existing stars; do not introduce another pin system. |
| Completion | Complete or reopen saved work without moving the provider message. |
| Explanations | Show why each message appears and whether the reason is your choice or a suggestion. |

The startup setting does not enable classification or change its account settings.
Home uses reminders, commitments, priority choices, and stars when classification is off.

## Screen structure

```text
Home                                      Open Inbox
Updated just now · All accounts

Due now
Reminders you set

Needs attention
Priority mail and Jev suggestions
Each row explains why it appears

Reply later                               Start replying [later release]
Messages you chose to answer

Since your last visit
New arrivals

Saved                                     Expand
Starred messages for quick reference
```

Use compact rows in one main column. Avoid a dashboard of equal-sized cards.
Hide empty sections and collapse Saved by default.
Initially show about eight rows, with accurate section totals and expansion controls.
Do not silently omit additional due reminders; expose their count and an obvious way to view all.

On desktop, open the existing reader beside Home when space permits.
On mobile, open the reader with a **Back to Home** control.
Restore selection, focus, and scroll position when you return.

Keep the order stable while you interact. Announce new items and offer an update control.
Do not replace an open reader or composer when settings or background data change.

## Entry and settings

Add `homeEnabled` to `AppSettings`, stored as `home.enabled`.
Use the same default on the server and client.

Setting text:

> **Show Home when the app opens**
> Start with important mail and reminders. Turn this off to start in Inbox.

The preference follows you across devices through the existing settings service.
Cache the last confirmed choice for offline startup.
Resolve the initial view without briefly showing Inbox and then switching to Home.
If settings cannot load and no cache exists, keep mail accessible with clear retry feedback.

Turning the setting off affects the next normal startup.
It does not interrupt the current view or delete reminders and commitments.
An explicit destination, such as a message link, takes precedence over startup selection.
Returning from a background tab does not force Home to open.

## Selection and ranking

Build Home from stored data. Opening Home must not trigger a model call.

| Section | Selection | Order |
| --- | --- | --- |
| Due now | Active reminders whose due time has passed | Earliest due time first |
| Needs attention | Explicit priority mail, security alerts, and action or reply suggestions | Protected security/action items and explicit priority first; recency breaks ties |
| Reply later | Open commitments you created | Oldest commitment first |
| Since your last visit | Newly ingested incoming mail since the previous visit boundary | Newest arrival first |
| Saved | Starred mail | Most recently starred where recorded; otherwise stable message date order |

Define and test a deterministic ranking tuple before implementation.
Do not invent an opaque score that mixes unrelated signals.
Priority must not demote protected security or action items into routine groups.

Preserve classification precedence: manual placement, sender override, deterministic rule, then Jev.
Priority is a separate preference; it does not change message classification.
Keep priority choices scoped to an account and sender or thread.

Use `asksAction`, `asksReply`, `timeSensitive`, class, and sender relationship where available.
Read confidence from the matching stored decision; do not attach an older decision to newer answers.
Missing answers and missing confidence remain unknown.
Reuse the existing `0.75` action breakout threshold for its current purpose.
Evaluate reply and time-sensitivity thresholds separately against labeled mail.

Time sensitivity can raise attention. It cannot create a deadline.
Use fixed reason labels, such as **You prioritized this sender**, **You starred this**,
and **May need your reply**. Show classification suggestions as suggestions.

Exclude junk, trash, drafts, and sent-only mail from automatic suggestions.
Explicit reminders may reference sent or archived messages.
If a target becomes unavailable or moves to trash, show that state on its saved work.
Do not silently delete the commitment or restore the message.

Group related messages only when existing thread links support the relationship.
Keep account labels and access to each copy.
Never infer that a shared subject alone proves a shared thread.
Show one main entry per conversation, in the highest applicable section.
Attach all applicable reasons and actions to that entry.
Explain section counts consistently when one entry represents several messages or saved work items.

Home remains advisory during shadow mode. It does not move mail or enable routing.
The existing classification evaluation gate continues to control automatic routing.

## Actions and lifecycle

| Action | Meaning | Effect on provider mail |
| --- | --- | --- |
| Reply later | I intend to answer this | None |
| Remind me | Bring this back at a chosen time | None |
| Star | Keep this easy to find | Existing synchronized star action |
| Complete | I finished this saved work item | None |
| Reopen | Restore this completed work item | None |
| Dismiss suggestion | Remove this suggestion from Home | None |
| Archive | Move mail out of the provider inbox | Existing archive service |
| Wrong suggestion | Correct classification with an explicit scope | Existing correction service |

Reply later and a reminder may coexist on the same conversation.
Completing one does not silently complete the other.
Opening a message follows existing read behavior, but never completes saved work.
The first release requires explicit completion after a reply.
Queued or uncertain sends must never imply completion.

Reminder choices are **Later today**, **Tomorrow**, and **Choose date and time**.
Show the resolved date, time, and timezone before saving.
Store the due instant and the timezone used to interpret the choice.
Handle daylight-saving transitions and invalid or ambiguous local times explicitly.
Do not offer a preset that resolves to a past time.

Reminders appear inside the app. Background notifications are outside this release.
Provide reschedule, cancel, complete, and reopen controls with clear save feedback.
Keep an accessible list of all active reminders, including future reminders.
Keep completed work accessible for review and reopening.

Dismissal applies to the current incoming message, not all future messages in its thread.
A new incoming reply can surface that conversation again.
Reclassification alone must not repeatedly restore a dismissed suggestion.
Provide undo for dismissal and completion.
Classification correction remains separate from dismissal.

## Visit tracking

Use ingestion order or a server cursor for new arrivals, not the sender's date.
Freeze the previous visit boundary for the current Home session.
Record the next boundary only after Home data loads successfully.
Do not advance it on failed or offline reads.

Use per-device visit tracking for the first release.
This prevents opening Home on one device from clearing another device's overview.
Keep old reminders and commitments independent of the arrival boundary.

## Data and service design

Add a `packages/home` application service with explicit read and mutation interfaces.
Keep ranking and reason generation separate from persistence for direct testing.

Proposed storage responsibilities:

- Priority preferences: account, sender or thread target, revision, and timestamps.
- Saved work: stable identifier, account, anchor message, kind, status, due time,
  timezone, revision, and timestamps.
- Dismissals: account and incoming message identifier, with timestamps.
- Visit cursor: per-device cursor outside mailbox flags and work state.

Use distinct saved work records so Reply later and reminders can coexist.
Do not overload a single `work_state` value for both.
Keep an anchor message so thread reconciliation cannot lose saved work.
Define how current thread membership is resolved when threads merge or split.
Review whether to extend or replace the reserved `conversation_state` table during schema design.

Expose `GET /home` with typed contracts for sections, items, reasons, totals,
freshness, classification coverage, and pagination.
Use bounded queries and stable cursors. Do not load the complete mailbox into the browser.
Resolve ranking before pagination so priority items cannot disappear beyond a generic recent-mail limit.

Add service-backed endpoints for priority, saved work, and dismissal changes.
Validate every input at the application programming interface boundary.
Check recovery generation before idempotency lookup.
Use revisions to reject conflicting edits from different devices.
Record audit events without message bodies or credentials.

Compute due status from persisted timestamps when reading Home.
In-app reminders do not require a job that performs mailbox writes.
If later features add workers, preserve the existing recovery and job-generation rules.

## Offline and failure states

| State | Behavior |
| --- | --- |
| Loading | Show section skeletons; preserve navigation access. |
| No accounts | Offer account setup. |
| First synchronization | Show progress and explain that suggestions are incomplete. |
| Classification disabled | Show explicit choices and new arrivals; offer access to settings. |
| Classification paused | Preserve stored results and show their age and paused status. |
| Partial classification | Show coverage; never claim all important mail has been found. |
| Empty Home | Show **No suggestions right now** and **Open Inbox**. |
| Offline | Show cached data with its timestamp and incomplete-data notice. |
| Mutation failure | Keep the item visible and provide retry feedback. |
| Recovery required | Stop mutations and use the existing recovery review flow. |
| Missing target | Keep saved work visible with an unavailable-message explanation. |

Version cached Home data and associate it with the recovery generation.
Clear or invalidate it after a generation change.
For the first release, new Home-specific mutations require connectivity.
Disable those controls offline with an explanation; do not report unsaved reminders as saved.
Existing mailbox actions continue to use their established offline behavior.

## Generative interface boundary

Borrow bounded component selection from the reviewed json-render experiment.
The first release uses deterministic composition from stored classification answers.
It does not add a second model call or a json-render dependency.

Use a small vocabulary of reminder rows, attention rows, message rows, and status notices.
Application code owns content, message references, reason labels, and action bindings.

A later experiment may let Jev choose approved variants or optional groups.
Keep navigation, due reminders, commitments, and action meanings fixed.
Validate every result and fall back to the standard layout on failure.
Email content cannot introduce components, executable code, destinations, or new actions.

The linked Gateway evaluator uses a different transport from the current TypeSafe adapter.
Any adoption requires a separate integration review, version pin, budget, and timeout policy.

## Implementation sequence

1. Update `SPEC.md` with the agreed scope, state meanings, ranking rules, and acceptance criteria.
2. Define contracts and migrations for priority, saved work, and dismissals. Add recovery-aware services.
3. Build and test `GET /home`, ranking, grouping, coverage, and pagination.
4. Add `homeEnabled`, startup selection, navigation, visit tracking, and cached reads.
5. Build Home, its actions, reminder controls, reader integration, and mobile behavior.
6. Add fixture scenarios and complete service, browser, accessibility, and recovery checks.
7. Evaluate selection against labeled mail, document limits, and enable the first release.

Primary integration points:

- `packages/contracts/src/index.ts`: settings and Home contracts.
- `packages/settings/src/service.ts`: stored startup preference.
- `packages/database/src/schema.ts`: durable Home records and indexes.
- `packages/classification`: existing answers, confidence, corrections, and evaluation rules.
- `packages/home`: proposed Home services and ranking.
- `apps/api`: validated Home routes and service wiring.
- `apps/web/src/components/mail/app-shell.tsx`: entry view and reader integration.
- `apps/web/src/components/mail/nav-pane.tsx`: Home navigation.
- `apps/web/src/components/settings/settings-screen.tsx`: startup preference.
- `apps/web/src/settings/settings-context.tsx`: preference loading and caching.
- `apps/web/src/components/home`: proposed screen and controls.
- `apps/web/e2e`: fixtures, workflows, and accessibility checks.

## Acceptance checks

- Home opens by default, and the saved setting reliably restores Inbox startup.
- Explicit destinations and active reading or composing are not interrupted.
- Home remains useful with Jev disabled or unavailable.
- Loading Home makes no model request and performs no mailbox mutation.
- Priority is independent of class and respects account scope.
- Security and high-confidence action items remain visible outside routine groups.
- Reading or archiving does not complete work.
- Reminder dates survive restarts, device changes, timezone changes, and restore review.
- Concurrent reschedule and completion operations produce explicit revision conflicts.
- Old recovery generations fail before idempotency lookup.
- A new incoming reply can restore a dismissed conversation; reclassification alone cannot.
- Thread reconciliation preserves anchored work without merging unrelated commitments.
- Future reminders and completed work remain accessible outside the default Home sections.
- Offline and incomplete states never imply that no important mail exists.
- Keyboard, focus restoration, screen readers, reduced motion, zoom, and touch controls work.
- Large-mailbox checks verify bounded queries and ranking before pagination.

Run `npm run check` for TypeScript changes and `npm test` for behavior changes.
Run database tests with `TEST_DATABASE_URL` so migration coverage does not skip.
Run the relevant web workflow and accessibility suites against the fixture server.
Before release, run the repository release gate with its required database configuration.
Keep the device matrix honest about untested Safari and real-iPhone behavior.

Evaluate Home separately from the existing routing gate.
Include important-message coverage, irrelevant suggestions, ranking beyond page limits,
and missing-classification cases. Do not treat a passed routing gate as proof of Home quality.

## Next release

- **Remind if no reply:** anchor a follow-up to a confirmed sent message and a chosen date.
  Use verified thread relationships and reply authorship. Exclude bounces and automatic replies.
  When synchronization is stale, say **No reply found in synced mail**.
- **Focus & Reply:** process explicit Reply later commitments with the existing composer.
  Keep remaining work visible and preserve drafts when moving between entries.
- **Sender grouping:** collapse routine messages by explicit sender preference.
  Keep grouping reversible and apply existing security and action breakout rules.

## Deferred features

- New-sender review, initially advisory and optional.
- Focus schedules and returning Home after inactivity.
- Push notifications and notification schedules.
- Suggested dates extracted from message content.
- Model-selected presentation variants.
- Generated summaries, drafting assistance, conversational search, and agent actions.
- Calendar integration, shared inboxes, and team collaboration.

## Research and rationale

Official sources reviewed on 2026-09-20. This review used documentation, not hands-on product testing.

| Source | Lesson applied |
| --- | --- |
| [HEY overview](https://www.hey.com/how-it-works/) | Separate correspondence, reading, and transactional purposes. |
| [HEY Focus & Reply](https://help.hey.com/article/764-focus-and-reply) | Record reply intentions and support a focused queue. |
| [HEY Set Aside](https://help.hey.com/article/777-set-aside) | Keep reference mail in a predictable place. |
| [HEY Bubble Up](https://help.hey.com/article/766-bubble-up) | Return mail when it becomes useful. |
| [HEY flow](https://www.hey.com/flow/) | Avoid requiring archive or delete after every read. |
| [Spark Home](https://sparkmailapp.com/help/general/home-screen) | Provide an optional overview before opening Inbox. |
| [Spark priority](https://sparkmailapp.com/help/sending-emails/pin-and-priority) | Let explicit sender and thread choices control attention. |
| [Spark reminders](https://sparkmailapp.com/help/sending-emails/set-follow-up-reminders) | Distinguish dated reminders from conditional follow-ups. |
| [Spark grouping](https://sparkmailapp.com/help/manage-your-inbox/group-emails-by-sender) | Compress repetitive service mail. |
| [Spark Gatekeeper](https://sparkmailapp.com/help/sending-emails/accept-or-block-new-senders) | Make sender review optional and explicit. |
| [Spark Done](https://sparkmailapp.com/help/manage-your-inbox/mark-as-done) | Preserve this app's separate archive and completion semantics. |
| [Spark AI Assistant](https://sparkmailapp.com/help/spark-ai/ai-assistant) | Defer broader assistance beyond the current bounded classifier. |
| [json-render commit](https://github.com/vercel-labs/json-render/commit/535f414eb4202d99f8260ce628c5e559c53e8046) | Keep composition bounded by application-owned components and actions. |

The scope and sequencing above are recommendations agreed in the planning conversation.
They do not imply that the referenced products share this app's data model or recovery rules.
