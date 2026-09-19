Modern email: UI, UX, and agent experience

Download the full 22-page report (PDF)⁠￼ · Download the editable Word report⁠￼

The report contains the competitive research, proposed information architecture, desktop and mobile design guidance, interaction flows, agent permission and approval models, failure scenarios, and a prioritized roadmap—with 38 linked sources.

Central recommendation: modern email should combine Gmail’s flexible controls, HEY’s attention boundaries, expert-client speed, and explicit management of commitments. Agents should operate within that system—not replace it with a chatbot.

This is a research snapshot as of September 18, 2026, based on public product documentation, primary research, and interface analysis. The design recommendations are hypotheses to prototype and test, not findings from a hands-on comparative usability study.

⸻

1. Why Gmail’s interface works so well

Gmail’s strength is not that every screen is beautiful or every feature is discoverable. My assessment is that its strongest quality is how much capability it gets from a relatively small set of reusable concepts.

Its controls combine into a system

Search, labels, filters, and inbox layouts reinforce each other. A search can become a filter; labels can represent overlapping categories; inbox sections can expose useful subsets of mail. Users can start with ordinary reading and replying, then progressively construct more sophisticated workflows without moving to a different application. 

That is the design lesson: build a small vocabulary that composes well, rather than a large collection of disconnected features.

A new email product should let the same concept—“messages from these people that need a reply”—work as a search, a saved view, a rule, and an agent’s permitted scope.

Retrieval makes lightweight organization possible

Gmail supports precise search operators for sender, recipient, attachments, dates, labels, and other criteria. This provides an alternative to meticulously filing every message into one correct location. 

The implication is important: organization and retrieval should complement each other. A modern interface should offer both:

Deterministic retrieval: “Show messages from this address with attachments last month.”

Semantic retrieval: “Find the latest agreed delivery date.”

Semantic search should not remove exact controls. It should expose the source messages and distinguish the current agreement from an earlier, superseded one.

It accommodates both scanning and expert operation

Gmail supports keyboard shortcuts and configurable inbox arrangements alongside ordinary point-and-click use. 

My interface interpretation is that its familiar row structure is valuable: users can compare sender, subject, preview, and time without opening each message. The opportunity is to preserve that scanability while making the next action clearer.

Replacing every row with a large “intelligent” card would usually be the wrong starting point.

It offers recoverable actions—but the semantics matter

Gmail’s Undo Send is a configurable cancellation window, not a general ability to retrieve an email after delivery. 

That distinction should guide modern email design: name what actually happened. “Drafted,” “queued,” “sent,” “cancelled,” and “recalled” must not become interchangeable reassurance.

What Gmail does not fully solve

The biggest opportunity is the gap between message organization and work management.

An email may be read but unanswered, archived but still actionable, or replied to while another obligation remains. A thread may contain several requests. Historical research on email deferral documents the importance of postponing messages that require replying, careful reading, or handling attachments. 

A better interface should make those obligations explicit instead of expecting people to encode them through unread status, stars, labels, and memory.

⸻

2. What HEY gets right: attention is a design problem

The HEY screenshot above illustrates a consequential choice: distinguish new mail from previously seen mail, rather than treating everything as one accumulating unread queue. Its Feed and Paper Trail do not use read/unread status in the same way as the Imbox. 

HEY’s most useful contributions are structural.

The Screener makes admission explicit. First-time senders are reviewed before being admitted to the main experience. The Feed separates subscription reading from correspondence. Focus & Reply creates a dedicated mode for responding to deferred messages. 

The lesson is not simply “copy HEY’s folders.” It is:

Receiving something should not automatically create an obligation to process it now.

That principle should shape notifications, counters, batching, and navigation.

Where HEY’s approach needs care

An opinionated attention system also introduces risks. A legitimate new customer may be an unknown sender. A normally low-priority source may send an urgent security notice. A newsletter may contain something a particular user genuinely needs to act on.

My recommendation is to borrow the boundaries while making exceptions easy to understand and correct. A person should be able to say:

“This message is important,” without necessarily saying, “Every future message from this sender is important.”

HEY should also not be described as inherently opposed to agents: its current site documents agent access through a CLI, alongside a human-oriented terminal interface. 

⸻

3. What other modern products contribute

These products are more useful as a collection of design patterns than as a single ranking.

Product	Relevant documented direction	Design lesson to borrow
Superhuman	Keyboard-driven operation, split inboxes, snippets, follow-ups, and collaboration. 	Reduce repeated interaction costs for frequent tasks.
Shortwave	Bundles, delivery schedules, task-oriented handling, and AI-driven workflows. 	Organize around processing modes and outcomes, not only chronology.
Spark	Unified accounts, priority handling, Gatekeeper, command center, and team features. 	Combine attention controls with readily accessible commands.
Fastmail	Masked addresses, custom domains, memos, and an ecosystem of open protocols. 	Control and interoperability are modern UX features—not alternatives to them.
Missive	Assignment, private discussion, collaborative drafts, and linked tasks. 	Shared email needs ownership and coordination, not just shared visibility.
Outlook Copilot	User-influenced prioritization with explanations and documented coverage limits. 	Explain priority decisions and show what was not evaluated.
Apple Mail	Categories, sender digests, time-sensitive crossover into Primary, and an ordinary List View alternative. 	Offer useful grouping without trapping users inside it.
Notion Mail	Custom views, properties, grouping, and AI labeling. 	Treat views as configurable perspectives on the same underlying mail.

Important status update: Notion says its Mail inbox will shut down on September 22, 2026. It belongs in this research as a design case study, not an adoption recommendation. 

My broader conclusion: the strongest ideas span several products. No single interface should be copied wholesale, and vendor productivity claims should not substitute for comparative testing.

⸻

4. Which broader interface trends belong in email?

Natural language plus visible controls

Natural language is useful for expressing intent:

“Keep receipts out of my main inbox, but surface anything overdue.”

The proposed product should translate that into an inspectable rule: matching criteria, exceptions, destination, notification behavior, and scope.

The user should then be able to edit it without repeatedly prompting an assistant. Conversation is an input method, not a replacement for durable controls.

Progressive disclosure, not permanent complexity

Progressive disclosure separates common actions from secondary capabilities. 

For email, that suggests a quiet default interface with optional saved views, advanced search, automation policies, and contextual assistance. It does not suggest hiding essential actions behind unexplained icons or making the assistant permanently occupy a fourth column.

Object-centered presentation

Gmail’s summary cards already demonstrate extracting useful structure from messages such as purchases, events, travel, and bills. 

The proposed extension is selective: show an invoice, meeting, approval, or delivery as a compact object when that representation clarifies the next decision.

Do not turn every message into a dashboard card. Ordinary correspondence should remain ordinary correspondence.

Expressive design without visual interference

Google’s Material 3 Expressive work emphasizes stronger visual hierarchy through shape, color, and motion. Apple’s Liquid Glass direction introduces translucent material in controls and navigation. These are relevant interface trends, but not evidence that more visual effects improve email work. 

For email, I would use expression sparingly: a distinctive primary action, clear selection, meaningful state changes, and quiet navigation. Reading and composing surfaces should remain opaque, stable, and highly legible.

Trust as part of the interface

The interface should show what an assistant examined, why a proposal matters, what will change, and how to correct it. This follows the broader human–AI interaction principle that expectations and error handling are part of the experience, not afterthoughts. 

⸻

5. The essential conceptual change: separate three kinds of state

This is the most important recommendation in the report.

State system	What it describes	Example states
Message state	What happened to the communication	Arrived, read, archived, drafted, queued, sent
Work state	What a person still needs to accomplish	Needs reply, needs review, waiting, later, resolved
Agent state	What delegated work is doing	Proposed, running, needs approval, completed, partly failed, cancelled

These should be linked, but not collapsed.

A read message can still require action. An archived conversation can contain an unresolved commitment. A generated draft is not authorized to send. Pausing an agent does not undo its previous actions.

This model also needs to handle multiple commitments within one conversation. Replying to one question must not automatically close another request.

Recommended navigation

The proposed primary navigation is:

Inbox → Needs action → Waiting → Later

Add Review when agents are enabled. Keep Reading, Records, and custom views secondary, with familiar access to Sent, Drafts, All Mail, Spam, and Trash.

These should be views over mail and commitments—not a forced new filing hierarchy.

“Waiting” deserves particular attention. It means waiting for a person, decision, document, or event. That is different from “Later,” which generally means reconsidering something at a chosen time.

⸻

6. How modern email should look

Desktop: three panes, not four permanent workspaces

The proposed default is a familiar arrangement:

Account / workspace     Search mail, people, files…       Compose
─────────────────────────────────────────────────────────────────
Navigation              Conversation list                Reader
Inbox                   Sender · Subject · Time          Subject
Needs action            Short preview                    Participants
Waiting                 One main work-state label        Conversation
Later
Review                                                   Linked task
                                                         or source card
Reading
Records                                                  Reply composer

For an initial prototype around a 1440-pixel desktop viewport, I would test a 200–240 px navigation rail, 360–440 px list, and flexible reader. These are proposed starting ranges, not validated specifications.

The list should prioritize sender, subject, a short preview, time, and one dominant work-state indicator. Avoid accumulating several competing priority, category, sentiment, and AI badges.

The reader should keep identity, recipients, attachments, and original text accessible. An AI summary can be useful, but it should not displace the evidence.

Keep the interface spatially stable

My recommendation is to avoid silently reordering the list while someone is processing it. Announce “5 new messages” and let the user choose when to refresh the current ordering.

Likewise, adaptive intelligence should change useful content more readily than it changes navigation structure or the location of essential controls.

Mobile: focused, sequential, and recoverable

Use one primary pane at a time, a small navigation set, and explicit transitions between list, thread, and composition. Swipes can accelerate common actions, but visible alternatives should exist.

Do not make a brief or accidental gesture produce an irreversible consequence.

Visual and accessibility principles

Use neutral reading surfaces, restrained accent color, strong text hierarchy, and status expressed through text or icons as well as color. Offer density choices without making essential controls inaccessible.

For prototypes, I would explore 36–44 px compact rows, 52–64 px comfortable rows, and 15–17 px reading text. Actual values need testing across platforms, font choices, zoom, and input methods.

Accessibility must cover complete workflows: keyboard navigation, visible focus, screen-reader labels, reflow, contrast, and alternatives to dragging. WCAG 2.2’s minimum target-size criterion is 24 × 24 CSS pixels with exceptions; a larger 44–48 px touch target is a proposed comfort target, not the same requirement. 

⸻

7. The interaction flows that matter most

Triage should resolve the next decision

Opening a message should not imply that the underlying work is done.

For an actionable message, the useful decisions are: respond now, create or accept a commitment, defer until a specific time, wait for an external condition, delegate, or resolve.

AI may suggest the likely state. The person should be able to correct this item, this sender, or the underlying rule separately.

Search should return current evidence

For “What delivery date did we agree?”, the proposed experience should show the answer, relevant messages, any later correction, and the account or time scope searched.

Finding an earlier date accurately is still a failure when the user asked for the current agreement.

Drafting should preserve authorship

A good drafting flow begins with the user’s intent and explicitly selected context. It produces editable text, does not invent facts to make the reply feel complete, and does not quietly add recipients or attachments.

The important metric is not how quickly a draft appears. It is how quickly a person can verify and send a correct response.

Rules should be previewable

A natural-language rule should first show examples of affected and unaffected messages. Users should choose whether it applies to future mail, existing mail, or both.

Before automatic changes, a “suggest only” or shadow mode should reveal whether the rule behaves as intended.

Shared email needs explicit ownership

For team workflows, the proposed interface should distinguish internal discussion from external replies, identify the current owner, and surface recent teammate activity before another response is sent.

Assignment, discussion, and linked tasks are established patterns in products such as Missive; they are more appropriate than treating collaboration as an extra label. 

⸻

8. Agent AX: the opportunity is controlled delegation

“Agent experience,” or AX, is an emerging term for making products usable by agents. For email, I would design both the machine-facing interface and the human experience of delegating and supervising work. 

This is already a practical product concern: HEY documents an agent CLI, while Google documents a Gmail MCP server in developer preview. The latter should not be mistaken for a universally available consumer capability. 

Start with high-value, bounded opportunities

The strongest initial opportunities are source-backed retrieval, concise briefings, suggested commitments, editable drafts, reversible classification, and follow-up tracking.

Scheduling, team routing, and cross-application execution can follow—but only once permissions, stale information, and partial failures are handled reliably.

The proposed decision rule is:

Net value = work avoided − review effort − repair effort − interruptions.

An agent that saves composition time but creates a new queue of uncertain outputs may not improve the experience.

Design an approval object, not a vague confirmation

“Should I handle this?” is insufficient.

An approval should identify the account, exact action, affected messages, supporting evidence, external recipients, attachments, and irreversible effects.

For outgoing mail, approval should bind to the reviewed content and recipients. If either changes—or the thread receives a material new reply—the system should recheck the situation rather than blindly executing an old approval.

Make autonomy specific to the action

The proposed default is narrow: reading, suggesting, reversible organization, and external effects should have different policies.

An agent might automatically classify approved receipt types, while still requiring review before forwarding an attachment. That is more useful than one global “autonomous mode” setting.

A crucial implementation detail: Gmail’s gmail.modify permission includes composing and sending, not merely label changes. A product promising “labels only” therefore needs an enforced restriction outside the model, even when the provider permission is broader. 

Design purposeful tools

The agent-facing surface should expose meaningful operations with clear inputs, stable identifiers, useful results, and realistic error handling. This is consistent with primary guidance on building effective agent tools. 

For the proposed product, each change should carry its account scope, target IDs, relevant preconditions, and retry protection. Results should identify what actually changed.

“Completed” should mean an action receipt exists—not that the model intended to do something.

Treat email content as untrusted input

OWASP explicitly identifies email and attachments as possible indirect prompt-injection sources. An incoming message can contain instructions aimed at an assistant rather than the human reader. 

The proposed defense is layered: separate source content from authorized instructions, constrain operations and destinations, prevent cross-account leakage, and require appropriate review for consequential effects.

The model itself must not be the authorization boundary.

Make partial failure and recovery visible

A trustworthy status might say:

“Labels updated on 18 of 20 messages. Two were unavailable.”

It should also distinguish an unknown outcome from a confirmed failure. A timed-out send must not simply be retried and potentially duplicated.

“Pause” should stop future operations. It should not falsely imply that earlier actions were undone.

⸻

9. What to build first—and how to judge it

The recommended sequence is reliable manual email → explicit work states → grounded assistance → bounded agents → selected cross-application workflows.

Agent access and audit foundations can be built early, while user-visible autonomy remains limited. The normal experience—reading, searching, replying, saving drafts—should not depend on a model being available.

The proposed north-star outcome is:

Commitments completed on time with less active email effort, while maintaining perceived control.

That should be supported by measures of correct triage, critical messages missed, current-source retrieval, draft verification time, automation repair effort, unintended external actions, and successful recovery.

Do not optimize primarily for inbox zero, generated draft count, AI acceptance rate, or time spent in the application.

The report proposes formative research across different message volumes, roles, technical comfort levels, and accessibility needs, followed by a longer opt-in pilot. Crucially, testing should include unknown senders, changing deadlines, conflicting replies, malicious email instructions, interrupted sends, and revoked agent access—not only attractive happy paths.

Final design direction

Make the first impression familiar, the second useful, and the third trustworthy.

The product should initially look like an excellent email client: a clear list, a readable conversation, and an obvious way to reply. It should then reveal a better model of outstanding work. Finally, it should allow delegation with visible boundaries, evidence, and outcomes.

The defining quality of modern email should not be how prominently it displays AI. It should be how clearly a person can answer:

What matters? What do I owe? What am I waiting for? What is the system allowed to do? And what has it actually done?
