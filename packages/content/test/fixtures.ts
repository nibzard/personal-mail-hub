/**
 * The redacted extraction corpus (SPEC section 12, "Defuddle corpus").
 *
 * Every fixture models one sanitized body — the DOMPurify derivative
 * ingestion stores in `bodies.html_sanitized` — with invented people and
 * `example` domains. Shapes come from real mail: an Outlook reply chain,
 * Gmail quoting, a newsletter, a calendar invite, a table-wrapped
 * one-liner, nested chains, heavy signatures, and the empty and text-only
 * cases the fallback paths need.
 */

export interface CorpusEntry {
  /** Stable corpus name; snapshots key on it. */
  name: string;
  /** The sanitized HTML derivative, or `null` when the message has none. */
  htmlSanitized: string | null;
  /** The plain-text alternative, or `null`. */
  textPlain: string | null;
}

export const CORPUS: CorpusEntry[] = [
  {
    name: "gmail-reply-chain",
    htmlSanitized:
      '<div dir="ltr">Thanks for the quick review. I pushed the patch to branch fix-leaf this morning and restarted the CI run. The leaf module failure was a missing fixture, not a regression. Two more checks should finish before noon and I will tag the release after that.<div><br></div><div class="gmail_quote"><div class="gmail_attr" dir="ltr">On Mon, Sep 15, 2026 at 9:12 AM Ana Silk &lt;<a href="mailto:ana@example.org">ana@example.org</a>&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="auto">Please rebase before the merge.</div><div dir="auto">The CI run failed on the leaf module, so the tag cannot go out yet.</div></blockquote></div></div>',
    textPlain:
      "Thanks for the quick review. I pushed the patch to branch fix-leaf this morning and restarted the CI run. The leaf module failure was a missing fixture, not a regression. Two more checks should finish before noon and I will tag the release after that.\n\nOn Mon, Sep 15, 2026 at 9:12 AM Ana Silk <ana@example.org> wrote:\n\n> Please rebase before the merge.\n> The CI run failed on the leaf module, so the tag cannot go out yet.",
  },
  {
    name: "outlook-reply-chain",
    htmlSanitized:
      '<div class="WordSection1"><p class="MsoNormal">The deploy finished. Both replicas answer on the new build and the error rate is back to the baseline. I left the old build tagged in case we need a comparison run tonight.<o:p></o:p></p><div style="border:none;border-left:solid blue 1.5pt;padding:0cm 0cm 0cm 4.0pt"><div><p class="MsoNormal"><b>From:</b> Rob Teller <span>&lt;rob@example.net&gt;</span><br><b>Sent:</b> Monday, September 14, 2026 4:02 PM<br><b>To:</b> Dana Marsh<br><b>Subject:</b> Replica restart</p></div><div><p class="MsoNormal">Can you restart replica two during the window? It holds a stale connection cache and the health checks flap because of it.<o:p></o:p></p></div></div><p class="MsoNormal"><span>Dana Marsh · Platform team · <a href="mailto:dana@example.net">dana@example.net</a></span><o:p></o:p></p></div>',
    textPlain:
      "The deploy finished. Both replicas answer on the new build and the error rate is back to the baseline. I left the old build tagged in case we need a comparison run tonight.\n\nFrom: Rob Teller <rob@example.net>\nSent: Monday, September 14, 2026 4:02 PM\nTo: Dana Marsh\nSubject: Replica restart\n\nCan you restart replica two during the window? It holds a stale connection cache and the health checks flap because of it.\n\nDana Marsh · Platform team · dana@example.net",
  },
  {
    name: "newsletter",
    htmlSanitized:
      '<div style="max-width:600px;margin:0 auto;font-family:sans-serif"><table role="presentation" width="100%"><tr><td style="padding:16px"><h1 style="font-size:22px">Storage weekly</h1><p style="color:#555">Issue 41 · September 18, 2026</p></td></tr><tr><td style="padding:0 16px"><h2>Postgres 18 beta notes</h2><p>The beta adds async I/O for sequential scans. Early runs show a lower p99 on large table scans, with the usual caveat about beta planners.</p><p><a href="https://www.postgresql.org/about/news/">Read the announcement</a></p><h2>One-liner: tail the write-ahead log</h2><p>A short recipe for streaming the write-ahead log to a warm standby without a full base backup first.</p></td></tr><tr><td style="padding:24px 16px;font-size:12px;color:#999"><p>You receive this because you subscribed at example.org.</p><p><a href="https://example.org/unsubscribe">Unsubscribe</a> · <a href="https://example.org/prefs">Preferences</a></p><p>Example Newsletter, 100 Example Street, Exampleton</p></td></tr></table></div>',
    textPlain:
      "Storage weekly\nIssue 41 · September 18, 2026\n\nPostgres 18 beta notes\nThe beta adds async I/O for sequential scans. Early runs show a lower p99 on large table scans, with the usual caveat about beta planners.\nRead the announcement: https://www.postgresql.org/about/news/\n\nOne-liner: tail the write-ahead log\nA short recipe for streaming the write-ahead log to a warm standby without a full base backup first.\n\nYou receive this because you subscribed at example.org.\nUnsubscribe: https://example.org/unsubscribe",
  },
  {
    name: "calendar-invite",
    htmlSanitized:
      '<div><p>Hello team,</p><p>This is a reminder for our scheduled meeting.</p><table border="0" cellpadding="4"><tr><td>Event:</td><td>Weekly storage review</td></tr><tr><td>When:</td><td>Thursday, September 24, 2026 from 10:00 to 10:30 (UTC)</td></tr><tr><td>Where:</td><td>Video call at meet.example.org/storage-weekly</td></tr><tr><td>Organizer:</td><td><a href="mailto:cal@example.org">cal@example.org</a></td></tr></table><p>Description: Backfill progress, restore drill results, and the index bloat question from last week.</p><p><a href="https://cal.example.org/event/41/accept">Accept</a> · <a href="https://cal.example.org/event/41/decline">Decline</a></p><p>-- Example Calendar</p></div>',
    textPlain:
      "Hello team,\n\nThis is a reminder for our scheduled meeting.\n\nEvent: Weekly storage review\nWhen: Thursday, September 24, 2026 from 10:00 to 10:30 (UTC)\nWhere: Video call at meet.example.org/storage-weekly\nOrganizer: cal@example.org\nDescription: Backfill progress, restore drill results, and the index bloat question from last week.",
  },
  {
    name: "table-wrapped-one-liner",
    htmlSanitized:
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td valign="top" style="font-family:sans-serif;font-size:14px">Approved. Ship it.</td></tr></table>',
    textPlain: "Approved. Ship it.",
  },
  {
    name: "nested-chain",
    htmlSanitized:
      '<div><p>Third note: the fix landed and the flaky test is gone. Thanks both.</p><blockquote><p>Second note: the flaky test comes from a shared fixture; I will isolate it today.</p><blockquote><p>First note: the test suite fails about once in ten runs on the shared runner. Someone with a faster machine should look.</p></blockquote></blockquote></div>',
    textPlain:
      "Third note: the fix landed and the flaky test is gone. Thanks both.\n\n> Second note: the flaky test comes from a shared fixture; I will isolate it today.\n>\n> > First note: the test suite fails about once in ten runs on the shared runner. Someone with a faster machine should look.",
  },
  {
    name: "signature-footer",
    htmlSanitized:
      '<div><p>The contract renewal is signed and countersigned. Scanned copy is attached; the paper original goes to the filing cabinet on floor two.</p><p>Best regards,</p><p style="color:#888;font-size:11px">Marta Vell<br>Operations · Example GmbH<br>Tel +49 30 0000000 · <a href="mailto:marta.vell@example.de">marta.vell@example.de</a><br>Examplestraße 12, 10115 Berlin<br><a href="https://example.de">example.de</a></p><p style="color:#888;font-size:11px">This message contains confidential information intended solely for the addressee. If you are not the addressee, please delete it and notify the sender.</p></div>',
    textPlain:
      "The contract renewal is signed and countersigned. Scanned copy is attached; the paper original goes to the filing cabinet on floor two.\n\nBest regards,\n\nMarta Vell\nOperations · Example GmbH\nTel +49 30 0000000 · marta.vell@example.de",
  },
  {
    name: "short-note",
    htmlSanitized: "<div>Lunch at noon?</div>",
    textPlain: "Lunch at noon?",
  },
  {
    name: "empty-html-with-text",
    htmlSanitized: "<div><br></div>",
    textPlain: "Approved from the plain part.",
  },
  {
    name: "empty-body",
    htmlSanitized: "<div><br></div>",
    textPlain: null,
  },
  {
    name: "text-only",
    htmlSanitized: null,
    textPlain:
      "The backup window moved to 02:00 UTC on Sunday. Nothing for you to do; this is a heads-up for the runbook.",
  },
];

/** One fixture by name. */
export function corpusEntry(name: string): CorpusEntry {
  const entry = CORPUS.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`No corpus entry named ${name}.`);
  }
  return entry;
}
