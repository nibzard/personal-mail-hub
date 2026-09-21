/*
 * Fixture mailbox for the browser checks (SPEC section 12, "Interface
 * acceptance"). The dataset deliberately holds the shapes the checks probe:
 * unread, starred, and attachment rows; a body that is still syncing; a
 * long subject and a long sender address for reflow; an HTML body with a
 * quoted chain, a remote tracking image, and a `cid:` inline; and enough
 * filler rows that the virtualized list stays bounded while the scope holds
 * many messages.
 */

/** Fixed clock the fixture dates derive from, in UTC. */
const BASE_TIME = "2026-09-17T09:30:00Z";

function sentAt(minutesAgo) {
  return new Date(Date.parse(BASE_TIME) - minutesAgo * 60_000).toISOString();
}

const personalInbox = "f-inbox";
const workInbox = "w-inbox";

export const accounts = [
  {
    id: "acc-personal",
    label: "Personal",
    color: "#2563eb",
    imapHost: "imap.personal.example",
    imapPort: 993,
    smtpHost: "smtp.personal.example",
    smtpPort: 465,
    smtpSecurity: "implicit_tls",
    username: "alex@personal.example",
    identities: [{ address: "alex@personal.example", name: "Alex", isDefault: true }],
    classifyEnabled: false,
    createdAt: "2026-08-01T08:00:00Z",
  },
  {
    id: "acc-work",
    label: "Work",
    color: "#ea580c",
    imapHost: "imap.work.example",
    imapPort: 993,
    smtpHost: "smtp.work.example",
    smtpPort: 587,
    smtpSecurity: "starttls_required",
    username: "alexandra.fernandezholmes@work.example",
    identities: [
      {
        address: "alexandra.fernandezholmes@work.example",
        name: "Alexandra Fernandez-Holmes",
        isDefault: true,
      },
    ],
    classifyEnabled: false,
    createdAt: "2026-08-02T08:00:00Z",
  },
];

export const foldersByAccount = {
  "acc-personal": {
    folders: [
      { id: personalInbox, name: "INBOX", role: "inbox" },
      { id: "f-sent", name: "Sent", role: "sent" },
      { id: "f-archive", name: "Archive", role: "archive" },
      { id: "f-projects", name: "Projects", role: null },
    ],
    pendingRoleChoices: [],
  },
  "acc-work": {
    folders: [
      { id: workInbox, name: "INBOX", role: "inbox" },
      { id: "w-sent", name: "Sent", role: "sent" },
      { id: "w-drafts", name: "Drafts", role: "drafts" },
    ],
    pendingRoleChoices: [],
  },
};

/** The long subject reflow checks truncate at every width. */
const LONG_SUBJECT =
  "Re: Re: Quarterly budget reconciliation for the infrastructure and " +
  "platform group — final numbers, open questions, and the follow-ups we " +
  "agreed to park until the November planning cycle begins in earnest";

/** The long address reflow checks keep to one line. */
const LONG_ADDRESS =
  "delphine.moreau-bernstein@very-long-department-name.work.example";

/**
 * One fixture message: its list row plus the folder that holds it. Details
 * live in `details` below; filler rows share one plain-text body.
 */
function row({
  id,
  accountId,
  folderId,
  minutesAgo,
  subject,
  snippet,
  sender,
  unread = false,
  flagged = false,
  hasAttachments = false,
  fetchedBody = true,
}) {
  const account = accounts.find((entry) => entry.id === accountId);
  return {
    messageId: id,
    accountId,
    folderId,
    accountLabel: account.label,
    accountColor: account.color,
    threadId: `thread-${id}`,
    subject,
    snippet,
    sender,
    sentAt: sentAt(minutesAgo),
    fetchedBody,
    hasAttachments,
    unread,
    flagged,
    activeOccurrences: 1,
    // The occurrence a mail action freezes (SPEC F4): its identifier, its
    // folder, and the revision the row was read at.
    occurrences: [{ occurrenceId: `occ-${id}`, folderId, revision: 1, modseq: null }],
    noServerCopy: false,
    sentCopyStatus: null,
    rank: null,
    highlight: null,
    highlightSource: null,
  };
}

export const namedRows = [
  row({
    id: "m-001",
    accountId: "acc-personal",
    folderId: personalInbox,
    minutesAgo: 12,
    subject: "Dinner on Saturday",
    snippet: "We booked the table for seven. Bring the photos from the trip.",
    sender: { address: "sam@personal.example", name: "Sam Rivera" },
    unread: true,
  }),
  row({
    id: "m-002",
    accountId: "acc-work",
    folderId: workInbox,
    minutesAgo: 34,
    subject: LONG_SUBJECT,
    snippet: "Summary of the reconciliation and the three open questions.",
    sender: { address: "finance@work.example", name: "Finance Team" },
  }),
  row({
    id: "m-003",
    accountId: "acc-work",
    folderId: workInbox,
    minutesAgo: 61,
    subject: "Contract draft for review",
    snippet: "The legal team sent the updated clauses in the attachment.",
    sender: { address: LONG_ADDRESS, name: null },
    hasAttachments: true,
  }),
  row({
    id: "m-004",
    accountId: "acc-personal",
    folderId: personalInbox,
    minutesAgo: 95,
    subject: "Photos from the hike",
    snippet: "The ridge above the lake, above the clouds this time.",
    sender: { address: "jordan@personal.example", name: "Jordan Li" },
    flagged: true,
  }),
  row({
    id: "m-005",
    accountId: "acc-work",
    folderId: workInbox,
    minutesAgo: 130,
    subject: "Weekly report with chart",
    snippet: "Numbers are up; the chart inside explains the spike.",
    sender: { address: "reports@work.example", name: null },
    hasAttachments: true,
  }),
  row({
    id: "m-006",
    accountId: "acc-personal",
    folderId: personalInbox,
    minutesAgo: 180,
    subject: "Older header-only message",
    snippet: null,
    sender: { address: "newsletter@old.example", name: "Old Newsletter" },
    fetchedBody: false,
  }),
  row({
    id: "m-007",
    accountId: "acc-work",
    folderId: workInbox,
    minutesAgo: 240,
    subject: "Plain text reply",
    snippet: "Works for me. I will bring the projector adapter.",
    sender: { address: "priya@work.example", name: "Priya Nair" },
  }),
  row({
    id: "m-008",
    accountId: "acc-personal",
    folderId: personalInbox,
    minutesAgo: 300,
    subject: "Thread with quoted history",
    snippet: "Latest answer on top of a long quoted chain.",
    sender: { address: "team@club.example", name: "Club Team" },
    unread: true,
  }),
];

/**
 * Filler rows so the list holds far more messages than the viewport
 * mounts (SPEC F12: a bounded rendered list). Both inboxes share them in
 * a stable, interleaved order.
 */
function fillerRows() {
  const rowsOut = [];
  // The SPEC measures palette feedback "with 100k stored messages", so the
  // fixture holds exactly 100,000 rows including the eight named ones.
  const count = 100_000 - namedRows.length;
  for (let index = 0; index < count; index += 1) {
    const accountId = index % 2 === 0 ? "acc-personal" : "acc-work";
    rowsOut.push(
      row({
        id: `m-filler-${String(index + 1).padStart(6, "0")}`,
        accountId,
        folderId: accountId === "acc-personal" ? personalInbox : workInbox,
        minutesAgo: 400 + index * 30,
        subject: `Archive digest ${String(index + 1).padStart(3, "0")}`,
        snippet: `Filler message ${index + 1} of the bounded-list fixture set.`,
        sender: { address: "digest@archive.example", name: "Archive Digest" },
      }),
    );
  }
  return rowsOut;
}

/** Every list row, newest first. */
export const messageRows = [...namedRows, ...fillerRows()].sort((a, b) =>
  a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0,
);

const HTML_BODY = [
  "<p>The latest answer sits on top, and the quoted chain below is collapsed.</p>",
  '<p><img src="https://tracker.example/pixel.gif" alt="Tracking pixel"></p>',
  '<p><img src="cid:chart@reports" alt="Weekly chart"></p>',
  '<blockquote><p>An older reply quoted here.</p>',
  "<blockquote><p>The oldest message of the chain.</p></blockquote></blockquote>",
  '<p><a href="https://example.com/notes">Meeting notes</a></p>',
].join("\n");

/** Message details the reader serves, keyed by message id. */
export const messageDetails = new Map(
  [
    {
      id: "m-001",
      accountId: "acc-personal",
      threadId: "thread-m-001",
      subject: "Dinner on Saturday",
      sender: { address: "sam@personal.example", name: "Sam Rivera" },
      recipients: {
        to: [{ address: "alex@personal.example", name: "Alex" }],
        cc: [],
      },
      sentAt: sentAt(12),
      fetchedBody: true,
      htmlSanitized:
        "<p>We booked the table for seven.</p><p>Bring the photos from the trip.</p>",
      textPlain: "We booked the table for seven.\n\nBring the photos from the trip.",
      attachments: [],
      classification: {
        classHint: "correspondence",
        source: "jev",
        asksAction: false,
        asksReply: true,
        timeSensitive: true,
      },
    },
    {
      id: "m-002",
      accountId: "acc-work",
      threadId: "thread-m-002",
      subject: LONG_SUBJECT,
      sender: { address: "finance@work.example", name: "Finance Team" },
      recipients: {
        to: [
          {
            address: "alexandra.fernandezholmes@work.example",
            name: "Alexandra Fernandez-Holmes",
          },
        ],
        cc: [{ address: LONG_ADDRESS, name: null }],
      },
      sentAt: sentAt(34),
      fetchedBody: true,
      htmlSanitized:
        "<p>Summary of the reconciliation and the three open questions.</p>",
      textPlain: "Summary of the reconciliation and the three open questions.",
      attachments: [],
    },
    {
      id: "m-003",
      accountId: "acc-work",
      threadId: "thread-m-003",
      subject: "Contract draft for review",
      sender: { address: LONG_ADDRESS, name: null },
      recipients: {
        to: [
          {
            address: "alexandra.fernandezholmes@work.example",
            name: "Alexandra Fernandez-Holmes",
          },
        ],
        cc: [],
      },
      sentAt: sentAt(61),
      fetchedBody: true,
      htmlSanitized: null,
      textPlain: "The legal team sent the updated clauses in the attachment.",
      classification: {
        classHint: "notification",
        source: "jev",
        asksAction: true,
        asksReply: false,
        timeSensitive: false,
      },
      attachments: [
        {
          id: "att-contract",
          filename: "contract-draft-v3.pdf",
          contentType: "application/pdf",
          sizeBytes: 2048,
          contentId: null,
          disposition: "attachment",
          inlineResolvable: false,
        },
      ],
    },
    {
      id: "m-004",
      accountId: "acc-personal",
      threadId: "thread-m-004",
      subject: "Photos from the hike",
      sender: { address: "jordan@personal.example", name: "Jordan Li" },
      recipients: {
        to: [{ address: "alex@personal.example", name: "Alex" }],
        cc: [],
      },
      sentAt: sentAt(95),
      fetchedBody: true,
      htmlSanitized: "<p>The ridge above the lake, above the clouds this time.</p>",
      textPlain: "The ridge above the lake, above the clouds this time.",
      attachments: [],
    },
    {
      id: "m-005",
      accountId: "acc-work",
      threadId: "thread-m-005",
      subject: "Weekly report with chart",
      sender: { address: "reports@work.example", name: null },
      recipients: {
        to: [
          {
            address: "alexandra.fernandezholmes@work.example",
            name: "Alexandra Fernandez-Holmes",
          },
        ],
        cc: [],
      },
      sentAt: sentAt(130),
      fetchedBody: true,
      htmlSanitized: HTML_BODY,
      textPlain:
        "The latest answer sits on top, and the quoted chain below is collapsed.",
      attachments: [
        {
          id: "att-chart",
          filename: "weekly-chart.png",
          contentType: "image/png",
          sizeBytes: 1218,
          contentId: "chart@reports",
          disposition: "inline",
          inlineResolvable: true,
        },
        {
          id: "att-numbers",
          filename: "weekly-numbers.csv",
          contentType: "text/csv",
          sizeBytes: 512,
          contentId: null,
          disposition: "attachment",
          inlineResolvable: false,
        },
      ],
    },
    {
      id: "m-006",
      accountId: "acc-personal",
      threadId: "thread-m-006",
      subject: "Older header-only message",
      sender: { address: "newsletter@old.example", name: "Old Newsletter" },
      recipients: null,
      sentAt: sentAt(180),
      fetchedBody: false,
      htmlSanitized: null,
      textPlain: null,
      attachments: [],
    },
    {
      id: "m-007",
      accountId: "acc-work",
      threadId: "thread-m-007",
      subject: "Plain text reply",
      sender: { address: "priya@work.example", name: "Priya Nair" },
      recipients: {
        to: [
          {
            address: "alexandra.fernandezholmes@work.example",
            name: "Alexandra Fernandez-Holmes",
          },
        ],
        cc: [],
      },
      sentAt: sentAt(240),
      fetchedBody: true,
      htmlSanitized: null,
      textPlain: "Works for me. I will bring the projector adapter.",
      attachments: [],
    },
    {
      id: "m-008",
      accountId: "acc-personal",
      threadId: "thread-m-008",
      subject: "Thread with quoted history",
      sender: { address: "team@club.example", name: "Club Team" },
      recipients: {
        to: [{ address: "alex@personal.example", name: "Alex" }],
        cc: [],
      },
      sentAt: sentAt(300),
      fetchedBody: true,
      htmlSanitized: HTML_BODY,
      textPlain: "Latest answer on top of a long quoted chain.",
      attachments: [
        {
          id: "att-chart",
          filename: "weekly-chart.png",
          contentType: "image/png",
          sizeBytes: 1218,
          contentId: "chart@reports",
          disposition: "inline",
          inlineResolvable: true,
        },
      ],
    },
  ].map((detail) => [detail.id, detail]),
);

/**
 * Filler details: every filler row reads the same plain-text body.
 */
for (const item of messageRows) {
  if (!messageDetails.has(item.messageId)) {
    messageDetails.set(item.messageId, {
      id: item.messageId,
      accountId: item.accountId,
      threadId: item.threadId,
      subject: item.subject,
      sender: item.sender,
      recipients: {
        to: [
          item.accountId === "acc-personal"
            ? { address: "alex@personal.example", name: "Alex" }
            : {
                address: "alexandra.fernandezholmes@work.example",
                name: "Alexandra Fernandez-Holmes",
              },
        ],
        cc: [],
      },
      sentAt: item.sentAt,
      fetchedBody: true,
      htmlSanitized: null,
      textPlain: item.snippet,
      attachments: [],
      classification: {
        classHint: null,
        source: null,
        asksAction: null,
        asksReply: null,
        timeSensitive: null,
      },
    });
  }
}

/** Decoded attachment bytes, keyed by attachment id. */
export const attachmentBytes = new Map([
  ["att-contract", Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, ...Array(2039).fill(0x41)])],
  [
    "att-chart",
    Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, ...Array(1202).fill(0x42),
    ]),
  ],
  ["att-numbers", new TextEncoder().encode("week,value\n2026-W37,118\n2026-W38,127\n")],
]);

/** The session-independent availability probe. */
export const authStatus = { ownerRegistered: true, login: "available", control: "ready" };

/**
 * The WebAuthn challenge the login ceremony hands out (SPEC section 9).
 * Fixed bytes keep the ceremony reproducible; the fixture refuses only a
 * malformed assertion, because a scripted browser cannot sign for real.
 */
export const LOGIN_CHALLENGE = "3epuFHkKtVmpHTFnQqtdCDrs3XA1PkrZaLr808owZ_M";

/**
 * The credential id the login options allow. The browser check registers a
 * virtual passkey that holds exactly this id, so the assertion the client
 * submits names the credential the fixture offered.
 */
export const LOGIN_CREDENTIAL_ID = "chxV5kOdLK-w1AWrvdpAE8ineCqUn4z_WsZ81fNcRGo";

/**
 * The recovery generation the fixture issues (SPEC section 10). It is a
 * fixed UUID so the offline queue accepts it as a server-issued generation.
 */
export const RECOVERY_GENERATION = "11111111-1111-4111-8111-111111111111";

/** The mail action kinds the fixture applies (SPEC F4). */
export const ACTION_KINDS = ["mark_read", "mark_unread", "star", "unstar", "archive", "move"];

/** The flag value each flag kind sets (SPEC F4). */
export const FLAG_KINDS = {
  mark_read: { flag: "unread", value: false },
  mark_unread: { flag: "unread", value: true },
  star: { flag: "flagged", value: true },
  unstar: { flag: "flagged", value: false },
};

/**
 * The settings record the fixture starts from (SPEC F10 defaults). The
 * server keeps the state in memory, so a browser run can change it and read
 * the change back.
 */
export const settings = {
  theme: "system",
  density: "compact",
  singleKeyShortcuts: true,
  cleanViewDefault: false,
  classificationEnabled: false,
  homeEnabled: false,
  classificationMonthlyCostCapUsd: null,
  backfillClassification: false,
};

/** Every value one settings key accepts, for the fixture's write check. */
export const settingsSchema = {
  theme: ["system", "light", "dark"],
  density: ["compact", "comfortable"],
  singleKeyShortcuts: "boolean",
  cleanViewDefault: "boolean",
  classificationEnabled: "boolean",
  homeEnabled: "boolean",
  classificationMonthlyCostCapUsd: "number-or-null",
  backfillClassification: "boolean",
};

/**
 * The per-account synchronization and queue status (SPEC section 11): one
 * account syncing bodies normally, one whose newest cycle contained a folder
 * failure beside its backfill progress.
 */
export const syncStatus = {
  checkedAt: "2026-09-17T09:31:00Z",
  queue: {
    state: "ok",
    depth: 2,
    oldestJobAt: "2026-09-17T09:30:00Z",
    oldestJobAgeSeconds: 60,
    oldestPendingWorkAt: "2026-09-17T09:29:30Z",
    oldestPendingWorkAgeSeconds: 90,
  },
  sends: { queued: 1, failed: 0, outcomeUnknown: 1 },
  classification: {
    circuit: "not_configured",
    calls: 0,
    errors: 0,
    description: "Jev classification is not configured.",
  },
  accounts: [
    {
      accountId: "acc-personal",
      sync: {
        lastCycleAt: "2026-09-17T09:29:00Z",
        cycleAgeSeconds: 120,
        backfillPendingFolders: 0,
        pendingBodies: 3,
        state: "syncing",
        folderErrors: 0,
        bodyErrors: 0,
        threadErrors: 0,
        folderFailureKinds: [],
        bodyFailureKinds: [],
        threadFailureKinds: [],
        pendingThreads: 0,
      },
      metrics: {
        messagesSynced: 48210,
        bodiesFetched: 48207,
        lastFullReconciliationAt: null,
        jevCalls: 0,
        jevErrors: 0,
      },
    },
    {
      accountId: "acc-work",
      sync: {
        lastCycleAt: "2026-09-17T09:30:00Z",
        cycleAgeSeconds: 60,
        backfillPendingFolders: 2,
        pendingBodies: 0,
        state: "degraded",
        folderErrors: 1,
        bodyErrors: 0,
        threadErrors: 0,
        folderFailureKinds: ["system_etimedout"],
        bodyFailureKinds: [],
        threadFailureKinds: [],
        pendingThreads: 0,
      },
      metrics: {
        messagesSynced: 51790,
        bodiesFetched: 51790,
        lastFullReconciliationAt: "2026-09-16T02:10:00Z",
        jevCalls: 0,
        jevErrors: 0,
      },
    },
  ],
};

/**
 * Clean views the reader serves, keyed by message id. `m-005` shows a real
 * extraction with the quoted chain collapsed; `m-002` shows the
 * sanitized-original fallback; messages without an HTML body have no entry,
 * because the reader offers no toggle for them.
 */
export const cleanViews = new Map([
  [
    "m-005",
    {
      html:
        "<p>The latest answer sits on top, and the quoted chain below is collapsed.</p>" +
        '<blockquote><p>An older reply quoted here.</p><p>The oldest message of the chain.</p></blockquote>',
      source: "extracted",
    },
  ],
  [
    "m-002",
    {
      html: "<p>Summary of the reconciliation and the three open questions.</p>",
      source: "original_fallback",
    },
  ],
]);

/*
 * Home fixture state (SPEC F13). The sections build from the named rows and
 * the per-session Home records below, so the shipped client meets the same
 * shapes the API serves: fixed reason codes, work summaries inside their
 * rows, honest coverage, and one visit boundary per device.
 */

/** The Home coverage line: two of the eight named rows carry stored answers. */
export const homeCoverage = {
  state: "active",
  description: "Classification is running.",
  considered: 8,
  answered: 2,
  newestAnswerAt: sentAt(12),
};

/**
 * The visit boundary a fresh device opens with: rows newer than 80 minutes
 * ago count as arrivals, so `since_visit` starts with `m-001`, `m-002`, and
 * `m-003`, while the starred `m-004` stays older and lands in Saved.
 */
export const homeInitialBoundary = sentAt(80);

/** The boundary a successful full Home read records for the device. */
export const homeNextBoundary = sentAt(12);

/**
 * Saved work every session starts with: one overdue reminder on `m-007`, so
 * the Due now section has a row whose due time already passed.
 */
export const homeSeedWork = [
  {
    id: "hw-due-1",
    kind: "reminder",
    status: "open",
    dueAt: "2026-09-17T08:00:00.000Z",
    timeZone: "UTC",
    revision: 1,
    anchorUnavailable: false,
    accountId: "acc-work",
    anchorMessageId: "m-007",
    anchor: null,
    createdAt: "2026-09-16T09:00:00.000Z",
    updatedAt: "2026-09-16T09:00:00.000Z",
    completedAt: null,
  },
];

/**
 * The suggestion reasons a stored classification answer justifies, keyed by
 * message id. Rows without an entry carry no suggestion, the way mail
 * without a stored answer stays out of the suggestion groups.
 */
export const homeSuggestionReasons = new Map([
  ["m-001", [
    { code: "may_need_reply", origin: "suggestion" },
    { code: "time_sensitive", origin: "suggestion" },
  ]],
  ["m-003", [{ code: "may_need_action", origin: "suggestion" }]],
]);
