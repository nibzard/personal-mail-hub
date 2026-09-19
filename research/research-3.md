For the email product we discussed, I would choose a web-first TypeScript application, a small conventional backend, and PostgreSQL—then package the same interface for mobile and desktop where necessary.

More specifically:

React + TypeScript + Vite → Fastify → PostgreSQL + pg-boss
PWA first; Capacitor for mobile; Tauri for desktop when justified.

My architectural recommendation is one shared interface, one backend codebase, one database, and a deliberately small number of moving parts.

That is the combination I would favor for your priorities—not the absolute cheapest possible prototype, but a system that can start inexpensively without making future maintenance or growth unnecessarily difficult.

I am assuming this is an email client and management layer connecting to existing mailboxes, rather than a company operating its own mail delivery infrastructure.

1. The stack I would actually choose

Layer	My choice	Why I would use it
Language and repository	TypeScript, strict mode, one repository	Keep frontend, backend, contracts, and most tests in one language. Make module boundaries explicit.
Application UI	React + Vite	Build a client application that can run in a browser or native web container, without requiring server rendering for the inbox. React documents Vite as an available starting point for this approach. 
Navigation and server data	React Router + TanStack Query	Use the router for navigation and Query for fetching, caching, and mutations. Avoid maintaining a second copy of all server data in a global UI store. 
Design system	A small, curated shadcn/ui foundation	Its component source lives in your application, making customization and inspection straightforward. Keep the collection small: owning the code also means owning its maintenance. 
Email composer	Tiptap’s open-source editor core	Use an existing rich-text editing foundation rather than building one. Its core is MIT-licensed; paid extensions and cloud services are separate. 
Backend	Node.js on a supported LTS release + Fastify	A conventional HTTP service with explicit routes, validation, logging, and modules. Fastify documents TypeScript support and a long-term support policy. 
Database	PostgreSQL + Drizzle	Keep durable application data relational and inspectable. Drizzle provides a TypeScript-oriented, SQL-like access layer rather than requiring a separate database service. 
Background work	pg-boss, using PostgreSQL	Scheduling, retries, transactional job creation, and background processing without introducing Redis or a separate message broker initially. 
Authentication	Better Auth, backed by PostgreSQL	An open-source authentication foundation rather than custom session/security code or a mandatory per-user authentication service. Keep mailbox authorization separate from application login. 
Testing	Vitest + Playwright	Unit/integration tests plus browser-level verification of actual user workflows. 
Deployment	Linux, Docker Compose, Caddy	A reproducible small deployment with automated HTTPS. Compose describes the application’s services; Caddy handles certificate management. 

This looks like several libraries, but the operational footprint is small: an application, a worker, a database, and an HTTPS entry point. Most frontend libraries do not become separately operated services.

I would not start with Kubernetes, microservices, a separate vector database, a separate search cluster, or a large agent-orchestration platform.

2. One UI for mobile and desktop: web-first is the important choice

For this product, I would make the web interface the primary implementation, not an approximation generated from a mobile-first application.

The proposed email experience is dominated by lists, text, selection, search, editing, keyboard navigation, and responsive panes. I would design those directly in the web UI, then reuse that UI.

Start with a responsive, installable web app

Build the desktop, tablet, and phone layouts together.

The components and domain logic should be shared, but the compositions should differ: a three-pane desktop layout should become a focused, sequential mobile layout—not three narrow columns.

A PWA can already provide an installed-app experience and notifications on supported platforms. Apple supports Web Push for Home Screen web apps on iOS and iPadOS, subject to installation and permission requirements. However, background synchronization is not uniformly available across browsers. Do not make reliable mailbox processing depend on a browser remaining active. 

Add Capacitor when mobile integration earns its cost

Capacitor is explicitly designed to put a web application inside an iOS or Android native container and expose native functionality through plugins. It does not require replacing the shared web UI. 

I would add it when the product needs better integration with notifications, sharing, attachments, deep links, or app-store distribution.

Importantly, Google’s OAuth flow should use a supported system-browser/native authentication flow—not simply open the authorization screen inside the app’s embedded WebView. Google documents restrictions on embedded user agents. 

Add Tauri only when a desktop application has a clear purpose

Tauri can reuse an existing web frontend and target Windows, macOS, Linux, Android, and iOS. It uses the operating system’s web renderer, with native application functionality implemented through its Rust/native layers. 

For this product, I would initially use it for desktop-specific needs such as system integration, local files, application shortcuts, or a more controlled offline experience.

Tauri also supports mobile, so one Tauri shell for all installed platforms is a legitimate alternative. Before choosing that, I would test the exact notification, OAuth, sharing, and attachment workflows the product needs.

The realistic promise is:

One shared UI and business-logic codebase, with small platform-specific adapters—not zero platform-specific work.

3. The backend should be a modular monolith

By modular monolith, I mean one backend codebase with clearly separated responsibilities—not one enormous file and not a collection of networked microservices.

My initial deployment would have these responsibilities:

Shared web UI
    │
    ▼
HTTP API
    │
    ├── Mailbox connections and authorization
    ├── Conversations and search
    ├── Commitments, waiting, and reminders
    ├── Drafts and outbound actions
    └── Agent policies and approvals
    │
    ▼
PostgreSQL
    │
    ▼
Background worker
    ├── Mail synchronization
    ├── Scheduled actions
    ├── Search indexing
    └── Optional AI processing

The API and worker can use the same application image and release, with different entry points. Initially, they can live on the same machine; later, they can scale separately.

PostgreSQL should do several jobs before you add more systems

I would use it for accounts, mailbox metadata, application work states, drafts, synchronization checkpoints, jobs, and audit records.

Start search with exact filters and PostgreSQL full-text search. Add pgvector only when semantic retrieval demonstrates useful results. Both capabilities can live alongside ordinary relational data. 

That does not mean PostgreSQL is automatically the right search engine forever. It means I would require evidence before adding another operational dependency.

For attachments, I would keep metadata in PostgreSQL and use a small storage abstraction. Fetch historical attachments from the mailbox provider on demand rather than copying every attachment during onboarding.

Keep the three state systems from the UX report separate

The architecture should reflect the earlier product recommendation:

Mailbox state: read, archived, drafted, sent.

Work state: needs reply, waiting, later, resolved.

Agent state: proposed, awaiting approval, running, completed, failed.

The mailbox provider remains authoritative for what happened in the mailbox. Your database is authoritative for your application’s commitments, policies, and agent records.

This distinction prevents a synchronization update from accidentally erasing the user’s work-management state.

Reliability matters more than framework benchmarks

For Gmail, Google documents both full and incremental synchronization. History can become unavailable, requiring a full resynchronization. Push notifications require renewed watches and should not be treated as a complete, permanently reliable event log. 

I would therefore build synchronization around persisted checkpoints, repeatable imports, deduplication, bounded retries, per-account concurrency limits, and periodic reconciliation.

The job queue helps, but a reliable queue does not guarantee that an external email is sent exactly once.

Consider a worker that sends an email successfully but loses the connection before receiving confirmation. Retrying blindly may send a duplicate. The application needs an explicit “outcome unknown” state and provider-specific reconciliation—not just another retry.

That is the kind of robustness I would prioritize before optimizing request throughput.

4. Offline support: local persistence, not a second distributed database project

I would make the application fast locally and resilient to disconnection, but would not initially build a fully replicated, local-first system across every device.

For browser persistence, Dexie provides an IndexedDB-based foundation. I would use it for recent conversations, local drafts, and a durable queue of pending user actions. TanStack Query would remain the in-memory server-data layer—not the sole durable record of an unsent draft. 

The initial offline contract should be understandable:

“You can read downloaded messages, continue drafting, and queue supported actions. The interface clearly shows what has not synchronized.”

I would require explicit conflict handling for drafts edited on two devices. “Last write wins” should not silently discard a long reply.

Browser storage also has quotas and eviction behavior. That means “saved on this device” and “safely synchronized” need different UI states. 

My recommendation: start with offline drafts and a bounded recent-mail cache. Introduce more sophisticated replication only when real workflows require it.

5. Make agentic coding effective through the repository, not hype

I would not choose a stack on an unsupported claim that a particular coding agent “knows it best.”

Instead, I would create conditions in which an agent can make changes that are easy to inspect and verify.

Give the repository one clear way to do each common task

Use one routing approach, one validation approach, one database access layer, one job system, and one component convention.

For the API, I would use validated schemas and generate an OpenAPI contract from them. Fastify supports schema-derived TypeScript typing through its type-provider system. This avoids separately maintained request types drifting away from runtime validation. 

Keep a small AGENTS.md containing module boundaries, development commands, testing requirements, and security rules. The format is specifically intended to provide project instructions to coding agents. 

Give agents a complete fake mailbox

The most useful development asset would be a deterministic mailbox simulator with representative conversations and failure cases.

An agent should be able to run the app without real credentials and reproduce duplicate notifications, expired authorization, changed drafts, malicious HTML, interrupted sends, and partial sync failures.

Pair that with one canonical implementation of a feature—for example, “snooze a conversation”—covering UI, validation, authorization, persistence, jobs, and tests.

That gives both humans and agents a pattern to follow instead of inviting a new architecture for each feature.

Make verification the completion criterion

A generated change is not finished because it compiles.

My required checks would include strict type checking, database integration tests, browser workflows, migration checks, and relevant permission tests. Playwright’s guidance emphasizes testing user-visible behavior and isolating tests; those are good defaults here. 

Production credentials and real mailbox contents should not be part of the ordinary agent development environment.

6. Product agents should use the same application services

I would initially integrate models through a thin adapter around the selected provider SDK, not a large orchestration framework.

The model should propose or request operations that the application already understands: find messages, prepare a draft, propose a rule, or request an approved send.

The same authorization and execution services should serve the UI, background jobs, and any future agent API.

My rule would be:

The model can request an action; deterministic application code decides whether that action is permitted and how it executes.

Keep approvals, execution records, cancellation, and budgets in PostgreSQL. Do not make an opaque model conversation the authoritative workflow record.

For cost control, I would begin with AI only where requested or clearly useful. Use ordinary code for sender rules, dates, grouping, and known patterns. Cache results against message versions, cap per-account spending, and avoid reprocessing an entire mailbox every time the user opens the app.

A local model can be an optional deployment choice, but I would not require a continuously running inference server for the basic product.

Email rendering needs its own security boundary

Incoming HTML should be sanitized and rendered in an isolated environment with a restrictive policy. DOMPurify is an established open-source sanitizer, but sanitization should be one layer—not the whole design. Native shells also need careful separation between untrusted message content and privileged application APIs. 

I would also keep mailbox credentials out of browser-readable storage, minimize sensitive logging, and test account isolation explicitly. PostgreSQL row-level security can provide an additional database-level boundary, but it still needs correctly configured roles and policies. 

This architecture is not end-to-end encrypted against your own server. A promise of that kind would require a different design for server-side search and agents.

7. What “almost free at small scale” realistically means

Almost-free infrastructure is achievable. An almost-free, production-grade email service is a broader claim.

The following are planning scenarios, not measured capacity guarantees. They exclude development labor, AI inference, compliance work, domains, taxes, and distribution fees.

Scenario	Sensible starting point	Cost interpretation
Local development or personal use	Run the application and PostgreSQL on existing hardware	Potentially zero incremental hosting spend, excluding hardware, electricity, connectivity, and your time.
Small self-hosted pilot	One modest VPS, bounded storage, low worker concurrency, off-machine backups	I would set an initial €10–25/month infrastructure budget, then measure actual mailbox and job load.
Managed database, less operational work	Hosted PostgreSQL plus an application/worker host	Higher cash cost, but potentially lower maintenance burden. Supabase Pro currently starts at $25/month, before your separate application hosting and additional usage. 
Availability-sensitive production	Redundant application capacity, managed or replicated database, tested recovery	Do not promise a near-zero budget. Price this against an explicit availability and recovery target.

For current price context, Hetzner’s published 2026 schedule lists CX23 at €5.49/month excluding IPv4 and VAT, subject to availability. DigitalOcean lists a 2 GiB RAM / 50 GiB disk basic instance at $12/month. Those are infrastructure reference points, not claims that a particular instance supports a particular number of mailboxes. 

Why I would not build around a free database tier

Supabase Free currently includes a 500 MB database, pauses inactive projects after one week, and does not include automatic backups. It can be useful for development, but those limits should not define a mail product’s architecture. 

For intuition, under an illustrative assumption:

10 users × 20,000 messages × 10 KB stored per message ≈ 2 GB, before indexes and attachments.

Mailbox history matters more than a marketing headline about how many authenticated users a free tier permits.

Use free allowances where they do not distort the design

For example, Cloudflare R2’s Standard storage currently includes a free allowance of 10 GB-month, with operation allowances and no direct internet-egress charge. It could be a useful low-cost attachment or backup destination behind a replaceable storage interface. It is still a managed dependency, not part of your self-hosted core. 

Two costs that should be investigated early

Gmail access: common mailbox scopes are restricted. Google states that storing or transmitting restricted-scope data on servers requires a security assessment. Work out the verification requirements for the intended deployment before treating hosting cost as the total launch cost. 

Native distribution: Apple’s Developer Program currently costs $99 per membership year, with regional pricing and eligible fee waivers. Native packaging therefore introduces costs and release work that a web-only launch can defer. 

A self-hosted server also needs patching, backup verification, monitoring, and recovery procedures. Low cash cost transfers work to the operator; it does not remove that work.

8. How this grows without an early rewrite

I would scale this in response to measurements, not registered-user milestones.

Initially, run the API, worker, and PostgreSQL on one machine, with restricted concurrency and off-machine backups. This is economical, but it is not high availability.

When background work begins affecting interaction latency, move workers to separate machines or processes with independent resource limits. Keep the same code and job contracts.

When database operations become the constraint, improve queries and indexes, separate bulk imports from interactive traffic, adjust retention, and move to better database infrastructure.

When a specific subsystem demonstrably needs independence, extract that subsystem. Search indexing, attachment processing, or particular provider connectors might eventually qualify. There is no need to decide that in advance.

My key measurements would be sync lag, oldest queued job, database latency, draft-save latency, failed actions, stored bytes per mailbox, and AI cost per completed task.

“Scales well” should mean a credible path to more capacity—not an assertion that one inexpensive server will handle unlimited users.

9. The alternatives I would take seriously

Alternative	When I would choose it	Why it is not my default here
Vue + Quasar	The team wants a more integrated UI toolkit and fewer frontend assembly decisions. Quasar supports web/PWA, mobile through Capacitor, and desktop through Electron. Its current tooling also exposes version-specific documentation to coding agents. 	This is the strongest alternative. My preference for React here is a product/engineering choice, not a claim that Quasar is less maintainable.
Expo / React Native	Mobile-native behavior is the primary product requirement. Expo also supports embedding shared DOM components. 	I would rather make the dense web email interface primary than manage a mixed native/DOM component architecture from the outset.
Next.js	The team already has strong Next.js expertise or needs substantial server-rendered application functionality. It supports self-hosting; Vercel is not mandatory. 	I do not see enough need for server rendering inside this inbox to make it my starting requirement.
Cloudflare-centric backend	Minimizing idle infrastructure spend is more important than easy portability of the whole backend. Workers has a free tier and paid pricing beginning with a $5 subscription. 	I would prefer a conventional Node/PostgreSQL deployment over shaping the mail-sync and job architecture around several managed platform services.

An existing team’s expertise can reasonably change the choice. I would not rewrite a healthy Vue, Django, or Rails application merely to standardize on TypeScript.

My final recommendation

For a new implementation, I would commit to:

React/TypeScript/Vite, Fastify, PostgreSQL/Drizzle, and pg-boss; a responsive PWA; a small Linux deployment; and strong automated tests.

I would defer native shells, semantic search, complex agent orchestration, and extra infrastructure until a concrete workflow justifies them.

The first serious technical prototype should prove mail synchronization, mobile composition, offline draft recovery, safe HTML rendering, and duplicate-safe outbound actions. Those are the risks that determine whether this becomes a dependable email product.

The best cost-saving decision is not finding a free host. It is building a system that needs few services, stores and processes only what is useful, and remains understandable enough that humans and coding agents can change it safely.
