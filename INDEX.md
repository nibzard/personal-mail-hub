# Email product research index

Research set for a modern email product. All documents are current as of
September 18, 2026. The set covers the market opportunity, buyer economics,
product design, and technical architecture.

## Suggested reading order

1. `research/research.md` — what to build and why.
2. `research/modern-email-report-pdf.md` — the full design report.
3. `research/research-3.md` — how to build it.
4. `SPEC.md` — the concrete build specification for the first version.
5. `research/research-2.md` — whether consumers will pay.
6. `research/research-1.md` — a short summary of item 2.
7. [json-render experimental APIs](research/json-render-experimental.md) — an optional Jev interface experiment.

## Documents

| File | Lines | Role |
| --- | --- | --- |
| `research/research.md` | 251 | Market and technology opportunity analysis. |
| `research/research-1.md` | 342 | Summary of the UI and UX report. |
| `research/research-2.md` | 164 | Consumer willingness-to-pay analysis. |
| `research/research-3.md` | 278 | Technical stack and architecture recommendation. |
| `research/modern-email-report-pdf.md` | 694 | Full text of the 22-page design report, with 38 sources. |
| [research/json-render-experimental.md](research/json-render-experimental.md) | 88 | Jev composition APIs, integration limits, and a proposed triage summary experiment. |
| `SPEC.md` | 1391 | Version 0.5 specification: secure setup, sync and thread reconciliation, reply rules, local sent records, attachment recovery, and restore safety. |

## `research/research.md` — opportunity analysis

Reviews three building blocks: Cloudflare Agentic Inbox, TypeSafe Jev, and
Pydantic AI. Concludes that the opportunity is software that receives work
through email and completes a business process. Not another AI writer.

Key content:

- Ranked table of ten opportunities. Top three: document-chasing agent,
  commitment ledger, agent-action gateway.
- A seven-stage processing pipeline: receive, reconcile, extract, judge,
  apply logic, approve, execute.
- Cost model for Jev decisions and the limits of its confidence scores.
- Validation plan: one buyer, one inbox, one case type, one system of record.

Main recommendation: start with a document-chasing workflow. Use the
commitment ledger as its data model. Build the agent-action gateway only with
access to teams already running agents.

## `research/research-1.md` — UX summary

Condensed version of the full report. Gives the central recommendation: combine
Gmail's composable controls, HEY's attention boundaries, expert-client speed,
and explicit commitment tracking. Agents operate inside that system under
supervision.

Covers: Gmail's strengths, HEY's attention model, patterns from eight other
products, the three-state model, desktop and mobile layout, key flows, and the
agent supervision model.

## `research/research-2.md` — willingness to pay

Finds a premium niche, not broad demand. Best purchase evidence: HEY reported
tens of thousands of paying customers at $99 per year in 2021. A 2015 survey
found 35.4% would pay anything to stop ad analysis; the median was $15 per year.

Key content:

- Price benchmarks: iCloud+ $0.99 per month through Superhuman $25 per month.
- Four buyer segments: storage, privacy and control, inbox overload,
  professional productivity.
- Free Gmail AI features weaken generic drafting as a paid differentiator.
- Proposed price test at $3, $5, and $8 per month, plus a premium tier near
  $99 per year.

## `research/research-3.md` — technical architecture

Recommends one shared codebase with few moving parts:

- Frontend: React, TypeScript, Vite, TanStack Query, shadcn/ui, Tiptap.
- Backend: Fastify modular monolith, Better Auth.
- Data: PostgreSQL, Drizzle, pg-boss, full-text search before vector search.
- Packaging: responsive PWA first. Add Capacitor or Tauri only when justified.

Key content:

- Three-state model mapped to storage. The mail provider stays authoritative
  for mailbox state. The application owns work and agent state.
- Sync design: persisted checkpoints, deduplication, and an explicit
  "outcome unknown" state for sends that time out.
- Offline support limited to drafts and a bounded recent-mail cache.
- Practices for agentic coding: one convention per task, a fake mailbox, and
  verification as the completion criterion.
- Cost scenarios: zero for local use, €10–25 per month for a small pilot.

## `research/modern-email-report-pdf.md` — full design report

Cleaned text extraction of the 22-page PDF "Modern email: UI, UX and agent
experience." The primary source for `research/research-1.md`.

Structure:

- Sections 01–06: research findings and competitive lessons.
- Sections 07–10: product model, navigation, visual direction, accessibility.
- Sections 11–13: triage, search, composition, rules, privacy, export.
- Sections 14–16: agent opportunities, supervision, architecture, safety.
- Sections 17–19: test scenarios, roadmap, decision checklist.
- 38 linked sources, all checked September 18, 2026.

Defines the primary navigation (Inbox, Needs action, Waiting, Later, Review),
the five-level autonomy ladder, and the approval-object model.

## `research/json-render-experimental.md` — Jev interface composition

Covers `experimental_composeSpec` and `experimental_createEvaluator` from
`@json-render/core`. Explains candidate selection, snapshot events, Gateway
setup, completion states, and the supported expression subset.

Proposes a read-only triage summary experiment. Separates this possible
Gateway integration from the existing TypeSafe classification plan.

## Shared conclusions

All documents agree on these points:

- Separate three states: message state, work state, and agent state. Do not
  collapse them into one unread count.
- Deterministic application code is the authorization boundary. The model can
  request actions; code decides whether they run.
- Approvals bind to the exact payload and recipients. Changed context needs
  revalidation.
- Email content is untrusted input. Defend against prompt injection in depth.
- Core email must work without a model. AI is added where it removes work
  without hiding consequences.
- The product should own business objects, such as commitments and cases. Not
  only message threads.

## Time-sensitive facts

- Notion Mail shuts down September 22, 2026. Last day to save native data is
  September 21. Treat it as a design case study only.
- TypeSafe Jev launched in early access September 15, 2026. Pricing and
  behavior may change.
- Gmail MCP server is in developer preview. Not a consumer capability.
- Google announced free Gmail AI features in January 2026, in US English.
