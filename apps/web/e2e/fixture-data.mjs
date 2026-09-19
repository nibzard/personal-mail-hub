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
    noServerCopy: false,
    sentCopyStatus: null,
    rank: null,
    highlight: null,
    highlightSource: null,
  };
}

const namedRows = [
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
