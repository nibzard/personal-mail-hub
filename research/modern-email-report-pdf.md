<!-- Cleaned text extraction of the 22-page PDF "Modern email: UI, UX and agent experience" (18 September 2026).
     Page headers, footers and page numbers removed; hard line breaks rejoined; tables converted to Markdown;
     line-wrap hyphenation repaired. The screen schematic on page 10 was column-interleaved by text
     extraction and is reconstructed here; alignment is approximate. -->

# Modern email

## UI, UX and agent experience

Research / product design / September 2026 · A research report and product design direction · 18 September 2026

**The central recommendation**

Build an email workspace that separates incoming messages, outstanding commitments, and agent activity. Keep the familiar inbox fast and dependable; add intelligence where it removes work without hiding consequences.

The design synthesis: Gmail's flexible primitives + HEY's attention boundaries + expert-client speed + explicit work state + supervised delegation.

**Reading guide**

- 01–06 Research findings and competitive lessons
- 07–10 Product model, navigation and visual direction
- 11–13 Core interactions, privacy and portability
- 14–16 Agent opportunities, supervision and architecture
- 17–19 Test scenarios, roadmap and decision checklist

Research basis: public product documentation, public interface examples, primary research and technical guidance. Product facts are cited; proposed designs and priorities are original recommendations, not validated usability findings.

---

## 01 / Executive direction

### What modern email should mean

Modern email should be an attention and commitment workspace built on a trustworthy message archive. Its job is not to maximize messages processed or generate more text. Its job is to help a person notice what matters, understand what is being asked, complete the right work, and delegate safely.

The key product distinction is between three independent states: a message has arrived; a person owes an action; an agent needs a decision. A read message can still require work. An unread newsletter can require nothing. A drafted reply can exist without permission to send. The interface must not collapse these into one unread count.

### The recommended direction

Keep a stable inbox, exact search, readable threads, keyboard navigation, undoable organization and obvious account identity. Add a small set of work views—Needs action, Waiting and Later—without forcing every user into a project-management system. Introduce agents first as evidence-backed helpers, then as narrowly authorized operators. Keep the complete manual workflow available.

The strongest differentiation is likely to be fewer forgotten commitments with less review effort, not an AI writing button. This is a product hypothesis to test, not a market-size or adoption forecast.

### Findings that change the 2026 comparison

Google's January 2026 Gmail announcement described AI Overviews and an AI Inbox direction; the latter was announced for trusted testers, not universal availability. Current Google developer documentation also describes a Gmail MCP server in developer preview. These are different surfaces and should not be conflated. [7, 9]

HEY now explicitly supports agents through its CLI, alongside a terminal interface for humans. It should not be described as a product that rejects agent access. [16]

Notion's Mail inbox is scheduled to close on 22 September 2026; its last day to save native data is 21 September. Gmail-synced messages remain, but some Mail-specific organization and reminders do not transfer. Notion's connected email-agent workflows continue. Treat its views and auto-labeling as design case studies, not a recommendation to adopt the retiring inbox. [26]

### Scope and limits

This report is desk research and heuristic analysis. It does not include authenticated hands-on benchmarking, accessibility certification, participant interviews, or a comparative security audit. Vendor productivity claims are not treated as independently measured outcomes. Availability can vary by plan, account, platform, region and rollout. The default design audience is an individual knowledge worker; personal and shared-team modes are addressed separately.

---

## 02 / Why Gmail works

### It provides a small, composable grammar

Gmail's useful foundation is not a particular shade of gray or icon shape. It is the combination of labels, filters, search, inbox layouts and direct actions. Labels support overlapping organization rather than a single folder location. Searches can become filters, and multiple-inbox layouts can be defined through searches or labels. These are interoperable building blocks rather than isolated features. [1–4]

Design interpretation: a person can begin with ordinary reading and replying, then build a more specialized system without changing clients. A message can belong to a client, a project and an action category. The UI does not need a new bespoke screen for each combination. This makes Gmail a useful baseline for extensible products, although flexibility can also create setup burden.

### Retrieval reduces the pressure to file perfectly

Gmail exposes exact operators for sender, dates, attachments, labels and other attributes. [2] That supports a powerful interaction pattern: remove an item from the immediate work surface while retaining a reliable path back to it.

Design implication: archive only feels safe when retrieval is understandable. A new client should retain visible search scope, interpretable filter chips and access to the original message. Semantic search should supplement these controls, not replace them with an opaque conversation.

### The same action can work at several levels

Gmail supports shortcuts for navigation, composition, replies, selection and organization; some require enabling in settings. [5] The design opportunity is to make single-message, multi-select and keyboard workflows share the same commands and language.

Design interpretation: expertise should compress an interaction, not change its meaning. A novice can click Archive, a regular user can select several threads, and an expert can use a key. This is more useful than hiding important features behind a separate "power mode."

### Recovery encourages action

Gmail's Undo Send is a configurable cancellation period of 5, 10, 20 or 30 seconds—not a general recall of delivered mail. [6] The broader lesson is that recovery must be accurate and visible. A reassuring label that promises more than the system can reverse is worse than a candid limitation.

### Why "great" needs qualification

These mechanisms explain why Gmail is a strong interaction baseline. They do not establish that it is universally the fastest, easiest, most private or most accessible client. Familiarity, organizational requirements and user preferences are separate from measured usability. A credible redesign should preserve the useful grammar while testing where it adds cognitive burden.

---

## 03 / What to preserve—and improve

### Preserve scanability, not every control

For the proposed product, preserve the list's ability to compare sender, subject, state and time without opening every message. Use consistent columns and restrained hierarchy. Offer a comfortable layout and an intentionally compact option. Do not replace every email row with a large decorative card.

Keep primary commands stable while secondary commands appear in context. Show shortcuts beside menu actions. Selection must visibly distinguish "this message," "this conversation," "these selected items," and "all matching results." An agent should use those same distinctions.

### Make the state model less ambiguous

Gmail labels apply to messages; Google notes that applying a label to a conversation does not necessarily label future replies. Search can also return a conversation when an individual message matches. [2, 3] These details reveal a general email-design problem: the visual object and the action's actual scope can differ.

Recommendation: show what is being changed, preserve message-level evidence, and state what will happen to new replies. "Apply to this thread and future matching replies" is a policy choice, not an implementation detail to hide.

### Do not make users encode work through unread status

Research on email deferral found that postponement is associated with work such as replying, careful reading and opening attachments; participants also used unread and flags as deferral strategies. This supports distinguishing reading from task completion. The research is historical and enterprise-oriented, not a measurement of today's entire email market. [38]

Add explicit "Needs reply," "Review attachment," "Waiting for Maya," and "Resume Friday" states. A thread may contain several commitments. Reading the thread should not complete them, and sending a reply should not automatically imply that every commitment is resolved.

### Intelligence is most useful near an object

Gmail's summary cards expose information about orders, events, travel and bills, with links to the emails underlying the card. [8] The useful precedent is a compact actionable object with provenance, not simply a shorter version of a message.

For a redesigned client, a meeting card should show proposed times and invitees; a delivery card should show status; an approval request should show the decision and deadline. Preserve the original and identify uncertain extraction. Do not force users to trust a summary in order to find the source.

Bottom line: improve Gmail by making commitments and consequences clearer, not by discarding its dependable interaction model.

---

## 04 / HEY: design around attention

### Its major innovation is policy, not styling

HEY's Screener gives users a decision about new senders before those senders enter their normal flow. Its Imbox, Feed and Paper Trail separate personal attention, reading and reference material. Reply Later and Set Aside distinguish different reasons to keep something nearby. [10, 11]

The UX lesson is that all incoming mail does not deserve the same interaction contract. A receipt should be available when needed, not demand the same treatment as a question from a colleague.

### Removing obligations can be a feature

HEY explicitly separates New for You from Previously Seen in the Imbox. The Feed and Paper Trail do not have a read/unread obligation. [12] The Feed also uses a reading-oriented presentation rather than making every item an inbox task. [13]

Design interpretation: this challenges the assumption that every message needs acknowledgment. A modern client can preserve unread as a useful transport indicator without turning every unread item into psychological debt. Reading views should be easy to leave unfinished.

### Match the interface to a working mode

HEY's Focus & Reply provides a dedicated way to work through deferred replies. [14] The design lesson is to distinguish rapid triage from concentrated response work. A reading mode, response session and records lookup need not share the same density or controls.

Borrow this through optional modes, not mandatory rituals. A user should be able to answer one message immediately without entering a special workflow.

### Where the model needs escape hatches

A sender is not a permanent category. One business can send newsletters, security warnings, receipts and a human reply. HEY's own help documents an exception: some automated notifications with reply headers appear in the Imbox despite Feed or Paper Trail routing, to avoid losing replies. [15]

For a new product, provide inspectable exceptions, a chronological All Mail view, and one-step correction. A new-sender gate should also protect legitimate unknown opportunities: surface its backlog, provide review reminders, and make admission reversible. Do not confuse "not approved yet" with spam.

### What to borrow

Borrow attention boundaries, freedom from unnecessary unread debt, and dedicated reply sessions. Do not copy unfamiliar vocabulary merely to appear original. "Needs action," "Reading" and "Records" may be easier to learn than a new branded term; this naming choice requires testing.

HEY's current agent CLI adds a further lesson: an opinionated human UI can coexist with machine-operable access. [16]

---

## 05 / Competitive patterns worth borrowing

These are feature-based design lessons, not numerical product rankings. Risks in the final column are this report's assessment, not findings of a comparative usability study.

| Product | Documented direction | Lesson and caution |
| --- | --- | --- |
| Superhuman Mail | Split inboxes, keyboard workflows, snippets, follow-up reminders, shared conversations and AI assistance. [17] | Reduce repeated interaction cost. Do not make speed depend on memorizing hidden commands. |
| Shortwave | AI filters, agent workflows, bundles, tasks, delivery schedules and team collaboration. [18] | Join organization to action. Avoid replacing one inbox with a crowded workflow system. |
| Spark | Unified accounts, priority handling, Gatekeeper, command controls and shared-inbox collaboration. [19] | Useful attention defaults can span accounts. Keep account identity explicit. |
| Fastmail | Custom domains, masked addresses, search, snooze, memos and export-oriented control. [20] | Modernity can mean ownership and reliability, not mandatory AI. |
| Missive | Assignment and watching, internal discussions, collaborative drafts and linked tasks. [21] | Shared email needs an owner and handoff state, not just more flags. |
| Outlook + Copilot | Customizable priority judgments and a visible explanation in the reading pane. [22] | Explain prioritization and its coverage; do not present an incomplete pass as complete. |
| Apple Mail | Categories, sender digests, time-sensitive crossover into Primary, and a return to List View. [23] | Group low-stakes mail without removing the ordinary inbox escape hatch. |
| Notion Mail—retiring | Custom views, groups, properties and AI labeling. Inbox shutdown scheduled for 22 September 2026. [24–26] | Borrow user-defined views; make workflow data portable. |

### Three distinct kinds of progress

Interaction progress makes existing work quicker: commands, shortcuts, predictable selection and less navigation. Workflow progress makes the work model clearer: ownership, waiting, deadlines, batching and linked records. Agent progress allows a system to execute bounded work on a user's behalf. These improvements should be evaluated separately.

A client can have excellent AI drafting and poor triage. It can have an attractive inbox and weak shared ownership. The right combination depends on the audience, rather than on which product has the longest feature list.

### A warning from the Notion transition

The design inference is broader than "export your email." A user invests in saved views, reminders, snippets and automation instructions. A client that stores those only in a proprietary layer must make that dependency clear and provide useful export. Product retirement alone does not establish why a product succeeded or failed. [26]

---

## 06 / Interface trends: adopt selectively

### Hybrid interfaces: direct controls plus language

Shortwave's natural-language automation and Gmail's announced AI search direction illustrate the move toward intent-based interaction. [7, 18] The proposed client should still expose exact filters, visible selections and a normal results list. Language is an additional way to express intent, not a replacement for seeing what will happen.

Application: "Put supplier receipts in Records" opens a rule preview with criteria, sample matches, exceptions and a scope selector. It does not immediately reorganize years of mail.

### Progressive disclosure and expert acceleration

Progressive disclosure separates primary tasks from less frequently needed controls. [36] Apply it through compact toolbars, a command palette, discoverable shortcuts and an optional inspector. Do not hide indispensable controls exclusively behind hover, gestures or a conversation with an assistant.

Application: keep Reply, Later and More visible in context; show richer workflow options only when needed. Preserve keyboard and screen-reader access to every action.

### Expressive hierarchy—not decorative noise

Google's Material 3 Expressive research explores how color, shape, containment and motion affect hierarchy and perception. Apple's 2025 Liquid Glass announcement describes a translucent navigation/control layer. These are visible design directions, not proof that a glassy or colorful inbox will improve email work. [34, 35]

Application: use expression in selection, a primary action, a progress transition or a meaningful empty state. Keep message bodies on stable, opaque surfaces. Avoid moving backgrounds, competing colored badges and low-contrast text over translucent panels.

### Adaptive content, stable navigation

Personalization should change what a view contains more often than where a control lives. A product can propose a saved view for a frequent project without silently moving the Inbox, reordering primary navigation or shifting rows beneath the pointer.

Application: offer "Five new messages" as a refresh affordance while someone processes a list. Explain why an item was prioritized. Let corrections affect a single message, a sender or a rule; do not guess the intended scope.

### Object-centered work and shared context

Task-linked conversations in Missive and configurable properties in Notion Mail provide precedents for email as more than a message list. [21, 24] Adopt compact objects when they clarify a job—an approval, meeting, shipment or follow-up. Keep ordinary correspondence as readable rows and threads.

### Visible trust is part of the interface

Microsoft's human–AI interaction guidance spans initial expectations, ongoing use and error handling. [28] For email, make source, scope, freshness, permission and recovery visible at the decision point. A generic "AI may make mistakes" footer is not a substitute for these controls.

---

## 07 / Design around human jobs

### A default audience, with deliberate variants

The proposed default is a knowledge worker handling personal correspondence, automated updates and multiple ongoing commitments. The most important jobs are to notice, understand, decide, respond, delegate, retrieve and follow through.

A personal-use mode should emphasize relationships, deliveries, appointments, bills and reading, with fewer workflow controls. A shared-team mode should add ownership, internal discussion, handoffs and response expectations. These are configuration choices, not justification for exposing every feature to every person.

### Three layers of state

| Layer | Example states | Rule for the design |
| --- | --- | --- |
| Message and delivery | Received, unread, read, draft, queued, sent, archived | Describes the message, not whether the person's work is complete. |
| Commitment | Needs reply, review, waiting, scheduled, resolved | Belongs to a task linked to source messages; several tasks may share one thread. |
| Agent operation | Proposed, running, needs review, completed, partly failed, cancelled | Describes delegated execution and its actual outcome. |

This is a proposed product model. It should be understandable without teaching users database terminology. The architecture, however, needs these distinctions to avoid contradictory badges and accidental completion.

### A canonical conversation, multiple useful views

Inbox, Needs action and a project view may all point to one conversation. They should not create copies of the conversation or competing task records. Tasks can reference multiple messages; a message can support several tasks. A record of who changed a task should remain accessible.

When a new reply arrives, mark the arrival as new. Reopen a completed commitment only when a new obligation exists or the user explicitly reopens it. A simple "Thanks" should not manufacture a new task. When automatic detection is uncertain, make a suggestion rather than silently rewriting work state.

### What completion means

"Archive" removes an item from the inbox surface. "Mark read" records viewing. "Resolve" closes a commitment. "Waiting" means another party owes the next step. "Later" schedules the user's next attention. These actions may be combined through an explicit preference, but they must not be indistinguishable.

The primary product promise becomes: you can leave the inbox without losing the work that matters. That promise requires honest reminders, clear ownership and reliable retrieval, not merely a clean-looking first screen.

---

## 08 / Information architecture

### Primary navigation

| View | User question | Inclusion rule |
| --- | --- | --- |
| Inbox | What has arrived that I have not handled? | Incoming triage surface, with a stable chronological option. |
| Needs action | What do I owe? | Open commitments, grouped by due state or context. |
| Waiting | What am I expecting from others? | Explicit waiting conditions and follow-up dates. |
| Later | What did I deliberately defer? | User-scheduled attention, including deferred reading or reply. |
| Review | What does my assistant need me to decide? | Pending approvals; shown when agent workflows are enabled. |

Keep Reading and Records in a secondary "Spaces" group, alongside custom project views. Keep Sent, Drafts, All Mail, Spam and Trash in a familiar mail group. Let users pin frequently used destinations; do not open with a dozen equal-weight navigation choices.

### A status strip, not another dashboard

An optional compact strip can summarize "2 due today · 3 waiting follow-ups · 1 approval." Each count should open the underlying items and declare whether it is an item count or conversation count. Avoid a large compulsory morning briefing that must be dismissed before reaching mail.

Unread counts can remain available, but they should not imply importance. The global attention indicator should represent meaningful pending work and expose its definition.

### Account and identity boundaries

Place the active account beside search and compose. In a unified view, show an unobtrusive account marker on rows and a prominent From identity in the composer. Never silently move personal context into a work-account draft. Cross-account search and AI retrieval should be explicit choices.

### Search as navigation

The persistent search field should support both exact queries and natural language. Show account scope and filter chips. A saved search can become a view; a reviewed rule can keep that view populated. Preserve access to a plain chronological list at all times.

### Empty and exceptional states

"No actions due" should be a useful stopping point, not a prompt to generate more activity. "No results" should distinguish zero matches from incomplete sync or unsupported attachments. "Review is clear" should not imply all agents are idle; expose running work separately in Activity.

This architecture is a starting hypothesis. Test whether Waiting and Later are understood without instruction, whether Review feels like a second inbox, and whether low-volume users benefit from a smaller default navigation set.

---

## 09 / Desktop screen blueprint

### Proposed structure at approximately 1440 pixels

Use three panes: navigation, list and reader. Keep the assistant as a contextual control or temporary inspector rather than a permanently open fourth column. The schematic below is an original low-fidelity specification, not a screenshot of an existing product.

```
+------------------------------------------------------------------+
| Work account      Search mail / ask a question      Activity Help |
+--------------+----------------------+----------------------------+
| Compose      | NEEDS ACTION         | Contract review            |
|              | Due today  All open  | From Maya · to you         |
| Inbox        |                      | Review · due today         |
|              | Maya                 | [View source] [Mark done]  |
| Needs action | Review revised clause|                            |
|              | Contract review      |                            |
| Waiting      | Due today · source   |                            |
|              | linked               |                            |
| Later        |                      |                            |
|              | Jordan               |                            |
| Review (1)   | Original conversation|                            |
|              | with collapsed old   |                            |
| Spaces       | replies              | [Reply] [Later] [More]     |
| Reading      | Waiting · Monday     |                            |
| Records      |                      | Draft with help (optional) |
|              | 5 new messages       |                            |
| All Mail     |                      |                            |
+--------------+----------------------+----------------------------+
```

### Proportions and row anatomy

Start with a 200–240 px navigation pane and a 360–440 px list in split view; let the reader take the remaining space. At narrower widths, collapse navigation before starving the reader. These are prototype ranges, not established standards.

A row should present sender, subject, short useful preview, time, and at most one dominant work-state marker. Show secondary metadata on focus, selection or expansion. Keep the checkbox distinct from the avatar. Do not make selecting a message depend on knowing that a decorative image is interactive.

Use inline cards only for a real object or decision. A source-backed deadline card can help; a separate AI summary, sentiment card, urgency score and three recommendation cards can bury the email itself.

### Interaction behavior

Opening a thread should preserve list position. Back returns to the same location. Multi-select changes the toolbar and exposes exact scope. New mail should not move an item beneath the pointer. A temporarily open assistant inspector should close predictably and restore reading width.

A useful reader hierarchy is: identity and participants; current request or object when available; latest message; older context; reply area. Keep raw message details, attachments and prior versions reachable without requiring the model to explain them.

---

## 10 / Mobile, visual language and access

### Mobile is a different layout, not a shrunken desktop

Use one pane at a time: list, thread, compose or review. Keep a short bottom navigation for Inbox, Actions and Search, with other destinations in a menu. Show agent Review as a clearly labeled destination when enabled, not as an unexplained sparkle badge.

Make swipes optional accelerators for Later or Archive. Keep equivalent visible actions and undo. A short accidental swipe must not send, delete permanently or approve an external action. Preserve draft state and scroll position when interrupted or moving between devices.

### Visual starting specification

| Element | Proposed starting point |
| --- | --- |
| Message rows | Compact: about 36–44 px; comfortable: about 52–64 px. Test with real content and zoom. |
| Reading typography | Approximately 15–17 px body text with user scaling; aim for a readable 60–80-character line. |
| Color | Neutral reading surfaces, one restrained action accent, semantic warning colors used sparingly. |
| Priority | Text plus icon or shape. Do not use red for every unread item or color as the only signal. |
| Motion | Short state transitions; no attention-seeking loops or moving content during selection. |
| Touch | Prefer generous 44–48 px targets where feasible; never rely on desktop density for touch. |

These dimensions are design hypotheses. Validate across languages, assistive settings, pointer types and display sizes rather than treating them as universal pixel rules.

### Accessibility is a release gate

WCAG 2.2 includes a 24-by-24 CSS-pixel minimum pointer-target criterion with exceptions, keyboard requirements, contrast criteria and focus requirements. Its minimum is not a reason to make frequently used touch controls that small. [37]

For this product, test complete triage, search, compose and agent-review journeys with keyboard and screen readers. Announce selection, action completion and failures without excessive live-region chatter. Maintain visible focus through list changes. Provide non-drag alternatives, reduced motion and dependable zoom/reflow.

AI-generated cards must have a sensible reading order, meaningful link names and accessible approval controls. An assistant should not be the workaround for an inaccessible interface. If a message's HTML is difficult to read, offer a readable view without silently changing quoted meaning or suppressing the original.

### Keep the product calm

Show only one dominant next step in a context. Let a user finish and leave. Expressive details should help recognition or state change, not turn professional correspondence into a stream of badges, streaks and attention rewards.

---

## 11 / Triage and task flows

### Flow A: decide what an incoming message means

A person opens Inbox and sees new arrivals without the list reshuffling. They can reply, archive, schedule attention, or create a linked action. Reading alone changes only the read state. The system can suggest an obligation, but the user can correct its type, owner and due date before accepting it.

When deferring, ask for the relevant condition: a time, a person's response, or a missing input. "Tomorrow" should not be the only answer to "I cannot deal with this yet." A message waiting for a contract attachment needs a different return condition from a newsletter saved for the weekend.

A useful completion message is "Moved to Later; returns Monday at 09:00." It should include timezone when ambiguity matters and a visible undo. It should not say "Done" when the user merely postponed work.

### Flow B: focused response work

Needs action can open a focused queue with the message, relevant attachment and draft visible together. After resolving one commitment, advance deliberately to the next item without unexpectedly discarding context.

Allow "Reply, then wait for confirmation" as a combined action whose effects are explicit. The waiting condition should name the expected person or event. A bounce is not a reply; an automated acknowledgment may not satisfy the condition. Let users choose how much detection to automate.

### Flow C: shared ownership

In team mode, a conversation can be assigned to one accountable owner and watched by others. Internal notes and external replies must have unmistakably different visual treatment and composer labels. Before sending, verify the active channel, identity and recipients.

Assignment is not completion. A reassignment should preserve the current task, due date, latest context and handoff note. If another teammate is writing or has just replied, surface that before a duplicate external response. These are proposed interaction requirements; Missive's assignment and collaboration features provide a relevant product precedent. [21]

### Good defaults should remain reversible

Avoid rules that resolve work simply because a message was opened, because a reply was drafted, or because the inbox count reached zero. Offer a clear history of transitions and an easy way to reopen a task.

Preserve the distinction between a conversation and a commitment during bulk actions. "Archive 12 threads" should not mean "complete every action linked to those threads." An explicit combined command may be useful, but its consequences must be previewed.

---

## 12 / Search and composition

### Retrieval should provide evidence, not just an answer

The search interface needs two complementary outputs: exact message results and, when requested, an answer grounded in those results. Users should be able to start from sender, date, attachment or project chips, or ask a natural-language question.

For "What deadline did we agree with Maya?", show the answer, the source message and any later message that changes it. Expose scope and freshness: which account was searched, what time range was used, when sync completed, and whether relevant attachments could be read. Absence of evidence is not evidence of no agreement.

Keep search useful when the model is unavailable. A generated answer must not displace the original results or make the user issue another prompt just to open a message. Let users save a deterministic search as a view; explain when a semantic query may produce changing results.

### Composition should make intent and identity clear

Keep From, To and external recipients easy to inspect. Reveal Cc and Bcc through obvious controls rather than obscure shortcuts. Display attachment names and readiness. Draft saving, offline changes, queued sending and actual delivery should be distinct states.

The default writing assistance should turn the user's short intent into an editable draft or improve a selected passage. It should not produce a long generic response that requires more reading than writing from scratch. Preserve the user's facts, level of certainty and decision.

A strong pattern is "Draft from these points" with an optional "Use this thread for context." Before using another conversation or account, show that scope. Flag unsupported dates, prices or promises rather than inventing details. Never add a recipient merely because that person appears in retrieved context.

### External actions need specific review

For an AI-assisted send, show the exact recipients, subject, body and attachments. When scheduling, show the actual date, time and timezone—not only "tomorrow morning." If the underlying thread changes before sending, reassess whether the approved draft is still valid.

Cancellation before dispatch and recall after delivery are not equivalent. Gmail's documented Undo Send window is a useful reminder to use accurate wording. [6] For this product, say "Cancel scheduled send" while cancellation is possible, and "Sent" once dispatch has occurred. Never promise a general-purpose undo for information already shared externally.

---

## 13 / Rules, privacy and portability

### Turn language into inspectable policy

A rule builder should support both precise criteria and plain-language setup. The output must be a reviewable policy: eligible accounts, matching conditions, exceptions, actions, whether historical mail is included, and what happens to future replies.

Preview examples and near-misses before enabling a rule. Offer a one-time run, a shadow mode that only records proposed changes, and bounded automatic operation. Keep versions so users can understand which policy caused a change. Gmail's search-to-filter flow and import/export support provide useful non-agent precedents. [4]

For "Organize supplier receipts," exclude uncertain messages from automatic archival. Flag unexpected attachments or mixed-purpose conversations for review. Limit how many items a new rule can affect until its behavior is understood.

### Attention controls should be honest

Offer scheduled digest delivery and per-account quiet hours. Reserve urgent interruption for explicit people, topics or conditions—not simply senders with high historical volume. Let users inspect exceptions and maintain a visible new-sender review area. Avoid silently burying legitimate unknown correspondents.

Notifications should say why they interrupted: "Direct question from your selected priority contact" is more useful than an unexplained urgency score. Provide separate controls for notification timing, inbox placement and work-state creation.

### Privacy is a set of controls, not a single badge

Expose what data an agent can read, where processing occurs, which provider receives content, retention behavior, and whether optional model-improvement use is enabled. Keep these choices distinct from ordinary mail synchronization. A user should be able to revoke agent access without losing the email client.

Default to no outbound tracking. A product that blocks inbound tracking but encourages tracking recipients should explain that asymmetry rather than presenting a blanket privacy claim. For sensitive organizations, content-level access controls and audit requirements need independent technical and policy review.

Do not label ordinary transport or server-storage encryption as end-to-end encryption. An end-to-end encrypted design also needs an explicit explanation of where authorized search and AI processing can access plaintext. This is an architectural decision, not a cosmetic settings choice.

### Export the work layer too

Export messages, contacts and attachments, but also linked commitments, saved views, reminders, snippets, rule definitions, agent policies and activity records. Prefer readable structured formats with stable source identifiers. Explain what another client can and cannot restore.

Notion Mail's retirement demonstrates why synced messages alone do not preserve a user's entire workflow. [26] Build migration and graceful agent disconnection into the product from the start.

---

## 14 / Agent AX and opportunities

### Define both sides of agent experience

"Agent experience" is an emerging term for how easily an agent can discover, understand and operate a product on a user's behalf. It is not a universally settled standard. [27] For email, two design surfaces matter: the machine-facing tools and the human experience of delegating, reviewing and recovering from their use.

HEY's CLI, Google's preview Gmail MCP server and Fastmail's standards-based APIs show different routes to programmatic access. [9, 16, 33] They do not establish that every operation is safe to automate or that all providers expose equivalent controls.

### Prioritize by net benefit, not apparent intelligence

Use this decision rule: net value = work avoided − review effort − repair effort − added interruption. It is a design heuristic, not a measured economic formula.

| Opportunity | Initial behavior | Main failure to guard against |
| --- | --- | --- |
| Briefing and retrieval | Read-only, linked sources, declared scope | Missing context presented as a complete answer. |
| Triage assistance | Suggest labels and work states; reversible actions later | Quietly hiding a legitimate important message. |
| Reply preparation | Draft from explicit intent and approved context | Fabricated promises or disclosure to wrong recipients. |
| Commitment tracking | Propose task, owner, due date and source | Turning an uncertain sentence into a false obligation. |
| Scheduling assistance | Suggest viable times; review external changes | Stale availability, wrong timezone or unintended invitees. |
| Team routing | Recommend owner; auto-assign only under policy | Dropped accountability or inaccessible context. |
| Cross-app execution | Narrow workflow, staged checkpoints | Partial success, duplicated changes or data leakage. |

### A concrete differentiated opportunity

Consider a user who says, "Prepare the follow-ups I owe this week, but do not send anything." A useful agent produces an auditable queue: who is waiting, what was promised, the supporting message, a proposed draft, and the reason it belongs in the queue. The user approves individual outcomes, not a vague global instruction.

A less useful design returns a long prose report requiring manual copying into drafts. A more dangerous design assumes that "prepare" authorizes sending. The opportunity lies in connecting intent to a reviewable product object.

### Avoid a second inbox of assistant chatter

Batch routine results, surface exceptions and let users set a review budget. Agent activity should be filterable by policy, account and outcome. Do not make users converse with an assistant to discover whether it sent an email, changed a label or failed halfway through.

---

## 15 / Human supervision experience

### Autonomy must be specific to the action

| Permission level | Appropriate starting behavior | Human control |
| --- | --- | --- |
| Read | Search and summarize permitted data | Clear scope, sources and revocation. |
| Propose | Suggest tasks, rules, labels or drafts | Accept, edit, reject; no hidden mutation. |
| Reversible act | Apply narrow labels or archive approved categories | Enforced limits, activity record and undo. |
| External effect | Send, forward, invite, share or publish | Review exact payload, identity and recipients. |
| Destructive / high-impact | Permanent deletion or broad forwarding | Disabled by default; separate exceptional authorization. |

This is the recommended default ladder, not a claim about every existing product. Higher autonomy can be considered for narrow, explicitly authorized workflows after evidence of reliability; the same approval setting should not govern every action.

### Design an approval object, not a chat question

An approval should state the proposed action, affected account and items, supporting sources, changes from the current state, external recipients, attachments, and any irreversible effect. Use separate buttons for Approve, Edit and Reject. A batch should expose its membership and exceptions before approval.

For an outgoing reply, bind approval to the exact reviewed payload and thread revision. If the content, attachments or recipients change, obtain new approval. If a new message arrives, flag the changed context rather than sending an outdated decision.

### Show execution truthfully

Use explicit states: Proposed, Running, Needs review, Completed, Partly failed and Cancelled. Keep a persistent activity record. "Completed" means the system has an action receipt, not merely that the model generated an intention to act.

A partial result should identify what succeeded and what did not: "Labels updated on 18 of 20 messages; 2 were unavailable." Retrying should not repeat completed external actions. A Pause control stops future operations; it does not imply that earlier effects were undone.

### Make correction useful

Let a person say "This message only," "This sender," or "Change the rule." Ask about scope at correction time. Show understandable reasons and source evidence rather than an invented confidence percentage or an opaque internal reasoning transcript.

Microsoft's human–AI guidance supports setting expectations and handling errors as integral parts of interaction design. [28] For email, the practical requirement is a low-friction path from noticing a mistake to correcting both the current item and, when intended, its future policy.

---

## 16 / Agent architecture and safety

### Design purposeful tools

Expose a small set of meaningful operations: search messages, retrieve a thread, inspect attachments, create a draft, propose commitments, preview a batch, apply an approved change and inspect execution status. Avoid giving an agent a huge undifferentiated wrapper over every provider API.

Anthropic's tool-engineering guidance emphasizes purposeful tools, clear descriptions, useful responses and realistic evaluations. MCP's tool specification provides a structured interface and recommends human control over invocations; interoperability alone is not a safety guarantee. [29, 31]

### A minimum action contract

Every mutation should carry account identity, stable target identifiers, the requested operation, relevant state/version preconditions and an idempotency key where appropriate. Return structured per-item outcomes, actual changed fields, timestamps and a receipt. Support dry runs, cancellation where meaningful, bounded batch sizes and clear rate-limit/error states.

Keep a product-side policy layer between the model and provider credentials. A UI promise such as "labels only" must be enforced there. Google's Gmail scope documentation is instructive: the modify scope includes reading, composing and sending, not just changing labels. Request the narrowest provider scopes available and impose stricter operation limits when provider scopes are broader than the product's promise. [32]

### Treat email as untrusted input

OWASP identifies email content and attachments among indirect prompt-injection sources. [30] A message can contain instructions that look like commands to the assistant. Hidden HTML, quoted text and retrieved attachments must not gain authority over the user's instruction or the application's permission policy.

Use defense in depth: segregate content from instructions; constrain tools and destinations; validate action arguments; prevent cross-account context leakage; limit external data egress; and require review for sensitive effects. A model's confidence or a keyword filter is not a complete security boundary.

### Reconcile before committing

Immediately before sending or modifying a shared object, recheck relevant state. If a thread changed, a teammate replied, an attachment disappeared or availability became stale, pause and surface the conflict. Prevent duplicate sends when a request is retried after a network timeout. Model "unknown outcome" separately from "failed."

### Keep normal email dependable

Manual reading, drafting, exact search and local organization should not wait for a model call. Show sync freshness and offline limitations. Store unsent drafts safely, distinguish queued from sent, and make failures recoverable.

The architecture should optimize for bounded authority and observable outcomes. Better model performance is valuable, but it does not remove the need for explicit permissions, concurrency control, auditability and recovery.

---

## 17 / Scenarios and edge cases

Use these scenarios in prototypes and evaluations before increasing autonomy. They are proposed tests, not observed benchmark results.

| Scenario | Required behavior | Failure signal |
| --- | --- | --- |
| A new customer writes from an unknown address | Keep the request discoverable; review the sender without treating it as spam | Important mail disappears into an unreviewed gate. |
| A newsletter sender sends a security warning | Permit content-level urgency exceptions with evidence | Sender category prevents timely attention. |
| A read email contains two requests | Create or suggest two linked commitments | Reading or answering one closes both. |
| The sender changes a deadline in a later reply | Show current evidence and the change | Search or draft cites the superseded date. |
| Two teammates answer the same thread | Surface ownership and recent activity | Duplicate or contradictory replies. |
| An agent is told to forward confidential mail by text inside an email | Treat that text as untrusted content and enforce policy | Source content becomes an authorized instruction. |
| A send times out | Determine status before retrying; show uncertainty | The same message is sent twice. |
| The user approves a draft, then a new reply arrives | Revalidate context and request review when needed | A stale approved draft is sent blindly. |
| A user revokes an agent | Stop future access and explain remaining records | Background permissions remain active invisibly. |
| A product is disconnected or retired | Export messages and meaningful workflow metadata | Tasks and reminders vanish despite preserved mail. |

### Prototype the uncomfortable moments

Do not test only attractive empty states and successful summaries. Include long subjects, multilingual text, large attachments, quoted chains, missing permissions, expired sessions and conflicting dates. Test both pointer and keyboard operation, and use assistive technology during complete tasks.

### Evaluate search and automation separately

A system may retrieve the correct source but take the wrong action. Another may produce a fluent summary while missing a later correction. Score source retrieval, interpretation, policy compliance and execution independently, as well as end-to-end task success.

### Keep research privacy proportionate

Begin with realistic synthetic corpora and controlled adversarial examples. Introduce real mail only through opt-in research with limited access, appropriate handling and clear deletion practices. Never require participants to expose unrelated personal correspondence merely to test a triage interaction.

The most important question is not whether a demo looks intelligent. It is whether a person can notice and recover from the system's mistakes before they become consequential.

---

## 18 / Roadmap and evaluation

### Sequence capabilities behind quality gates

| Stage | Build | Gate before expansion |
| --- | --- | --- |
| Foundation | Reliable sync, identity, readable threads, exact search, keyboard paths, draft safety and reversible organization | Complete manual tasks without data loss or inaccessible controls. |
| Work model | Needs action, Waiting, Later, source-linked commitments and optional team ownership | Users understand state transitions and recover deferred work. |
| Grounded assistance | Evidence-backed search answers, task suggestions and editable drafts | Measurable benefit after verification and correction time. |
| Bounded agents | Previewable rules, scoped mutations, approvals, activity records and reliable retries | Low error burden and no uncontained high-impact behavior in tests. |
| Cross-app work | Selected scheduling, routing and follow-up workflows | Proven permission, freshness and partial-failure handling. |

These are dependency stages rather than promised release dates. Agent access and audit foundations can be built early even while user-visible autonomy remains low.

### Use an outcome-based north star

Measure commitments completed on time with less active email effort, alongside perceived control. Do not optimize primarily for inbox zero, number of generated drafts, messages sent, AI acceptance rate or daily time in the app.

For triage, measure time to a correct decision and critical false negatives, especially among unknown senders and bundled mail. For retrieval, measure whether the right current source is found—not whether the answer sounds plausible. For drafting, include time spent verifying and correcting the output. For agents, measure interventions, repairs, external-action incidents and successful recovery.

Track interaction responsiveness, sync freshness and reliability separately from model response time. A reasonable prototype goal is immediate feedback for local actions, with explicit pending states for remote work. Final latency targets should be based on instrumentation and user testing, not asserted as measured here.

### A practical research program

Start with a formative group of roughly 12–18 participants across message volume, role and technical comfort, including assistive-technology users. This is a proposed discovery sample, not a statistically representative validation. Establish a baseline diary, then use counterbalanced tasks comparing ordinary inbox handling with the new work-state model.

Follow with an opt-in multiweek pilot to detect lost commitments, notification fatigue and automation-review burden. Use shadow mode before automatic changes. Quantitative effect claims require an appropriately powered study and clearly defined tasks, populations and error severity.

### A release can fail despite higher speed

Reject a change that makes average triage faster while hiding more critical mail, increases output while raising correction burden, or reduces clicks while making state harder to understand. Compare the complete cost of getting a task right, including the cost of recovery.

---

## 19 / Design decisions to carry forward

### The product should feel familiar before it feels intelligent

The first impression should be a clear message list, a readable conversation and an obvious way to reply. The second should be relief: the user can separate new arrivals from outstanding work. The third should be confidence that delegated work is visible and controlled.

### Keep these commitments in the design brief

A dependable core. Every essential email task works without AI. Exact search, original messages, account identity, drafts, keyboard operation and recovery remain first-class.

Separate states. Read is not resolved; archived is not complete; drafted is not sent; paused is not undone. Keep these distinctions visible in language, data and interaction.

A restrained work layer. Offer Needs action, Waiting and Later as useful views, not a mandatory productivity doctrine. Use compact object cards only when an object clarifies the next decision.

Calm attention. Make batching, sender review and priority understandable and correctable. Preserve an All Mail route. Do not turn low-stakes content into a permanent unread obligation.

Agents with bounded authority. Use meaningful tools, enforced permissions, evidence-backed proposals, exact approvals, action receipts and explicit partial failures. Do not ask the model itself to be the authorization boundary.

Trust that survives exit. Make privacy settings specific, revocation straightforward and workflow data portable. A user should not lose commitments merely because a client changes direction.

### What not to build first

Avoid a chat-first replacement for the inbox; an always-open assistant sidebar; giant cards for every message; autonomous reordering without explanation; generic confidence percentages; universal auto-send; or a dashboard that creates another queue to maintain.

Some of these ideas can serve particular workflows. None should be the default merely because it looks contemporary or demos well.

### Final recommendation

The best modern email experience is not "Gmail plus more AI." It is a familiar, efficient communication surface with an explicit model of attention, commitments and delegated work. Borrow Gmail's composable controls, HEY's boundaries, expert-client speed and collaborative ownership. Add agents only where the product can make their scope, evidence and consequences easier to understand than doing the work manually. That is the design hypothesis worth prototyping and measuring.

---

## Sources

All sources were checked on 18 September 2026. Product documentation supports feature descriptions; analysis and proposed specifications are this report's recommendations.

- [01] Google — Change your Gmail inbox layout (support.google.com)
- [02] Google — Refine searches in Gmail (support.google.com)
- [03] Google — Create and manage labels in Gmail (support.google.com)
- [04] Google — Create rules to filter your emails (support.google.com)
- [05] Google — Keyboard shortcuts for Gmail (support.google.com)
- [06] Google — Send or unsend Gmail messages (support.google.com)
- [07] Google — Gmail is entering the Gemini era, 8 January 2026 (blog.google)
- [08] Google — Use summary cards in Gmail (support.google.com)
- [09] Google — Configure the Gmail MCP server, developer preview (developers.google.com)
- [10] HEY — Features (www.hey.com)
- [11] HEY — The Screener (www.hey.com)
- [12] HEY — New for You and Previously Seen (help.hey.com)
- [13] HEY — The Feed (www.hey.com)
- [14] HEY — Focus and Reply (www.hey.com)
- [15] HEY — Why notifications go to the Imbox instead of Feed or Paper Trail (help.hey.com)
- [16] HEY — AI agents, CLI and TUI (www.hey.com)
- [17] Superhuman — Mail product (superhuman.com)
- [18] Shortwave — Product and agent workflows (www.shortwave.com)
- [19] Spark — Features (sparkmailapp.com)
- [20] Fastmail — Features (www.fastmail.com)
- [21] Missive — Features (missiveapp.com)
- [22] Microsoft — Prioritize my inbox (support.microsoft.com)
- [23] Apple — Automatically categorize incoming emails in Mail on iPhone (support.apple.com)
- [24] Notion — Views, groups, filters and properties (www.notion.com)
- [25] Notion — Organize your inbox with AI auto labeling (www.notion.com)
- [26] Notion — Mail inbox shutdown: what to do next (www.notion.com)
- [27] Agent Experience — Emerging AX definition and community (agentexperience.ax)
- [28] Microsoft Research — Guidelines for Human–AI Interaction, CHI 2019 (www.microsoft.com)
- [29] Anthropic — Writing effective tools for agents, 11 September 2025 (www.anthropic.com)
- [30] OWASP — LLM Prompt Injection Prevention Cheat Sheet (cheatsheetseries.owasp.org)
- [31] Model Context Protocol — Tools specification, 18 June 2025 revision (modelcontextprotocol.io)
- [32] Google — Choose Gmail API scopes (developers.google.com)
- [33] Fastmail — API documentation and open protocols (www.fastmail.com)
- [34] Google Design — Research behind Material 3 Expressive (design.google)
- [35] Apple — New software design / Liquid Glass, 9 June 2025 (www.apple.com)
- [36] Nielsen Norman Group — Progressive Disclosure (www.nngroup.com)
- [37] W3C — Web Content Accessibility Guidelines 2.2 (www.w3.org)
- [38] Sarrafzadeh et al. — Characterizing and Predicting Email Deferral Behaviour, WSDM 2019 (www.microsoft.com)

Evidence note: historical research informs design hypotheses; it is not presented as a current product benchmark. The MCP citation identifies the consulted specification revision, not a claim that it is the newest revision.
