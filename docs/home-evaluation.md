# Home selection evaluation

SPEC F13 and the section 12 "Home acceptance" list require one evaluation of
what the Home overview surfaces, run separately from the routing gate. A
passed routing gate is not proof of Home quality. This document records how
the evaluation works and what the run on 2026-09-20 measured.

## What the command does

    npm run eval:home -- --labels <file.jsonl>

The label file holds one JSON object per line, over mail you read yourself.
Blank lines and `#` comments are allowed:

    {"messageId": "<uuid>", "class": "correspondence", "asksReply": true}

The keys `asksAction`, `asksReply`, and `timeSensitive` are optional. The
classes are the eight message classes. Every label must name a stored
message; a typo fails the run instead of silently shrinking the set.

The command walks the real Home answer the way the client does: pages of
eight, following cursors, across Due now, Needs attention, and Reply later.
So a row that ranks past the first page must still be found. It then
measures four things:

- **Important coverage**: labeled important mail with a stored answer that
  the attention sections hold. An absence you chose (a dismissal) or the
  scope excludes (mail outside the inbox) is reported with its reason, not
  failed. An absence with no stored answer behind it is unexplained, and it
  fails the run.
- **Irrelevant suggestions**: labeled routine mail (newsletter, marketing,
  notification, bounce) that the attention sections suggest. Every one is a
  defect. Rows Saved holds because you starred them do not count.
- **Ranking past page limits**: important rows found on a later page. The
  number shows how much the paged walk had to reach past the first page.
- **Missing classification**: labeled important mail with no stored answer.
  Home makes no model call, so it cannot suggest these. This is the blind
  spot the coverage line on the screen names.

The command records no verdict and touches no owner data. Home stays
advisory whatever the numbers say. The exit code is 0 when nothing
unexplained is missing and nothing routine was suggested, and 1 otherwise.

## The recorded run

Run on 2026-09-20 against a scratch database seeded with a synthetic
corpus of 119 messages over two accounts, with 119 hand-written labels the
seeder knew in advance:

| Group | Messages | Stored answer | In inbox | What it tests |
| --- | --- | --- | --- | --- |
| Important, Personal | 15 | 3 security alerts, 4 action, 6 reply, 2 time-sensitive | yes | Coverage, including rows past page one |
| Important, Work | 4 | 2 action, 1 reply, 1 time-sensitive | yes | Coverage on the second account |
| Important, archived | 5 | action asks | no | The `outside_inbox` explanation |
| Important, dismissed | 3 | reply asks | yes | The `dismissed` explanation |
| Important, unanswered | 8 | none | yes | The blind spot |
| Routine, Personal | 50 | class answers, 10 starred | yes | No routine suggestions, stars are choices |
| Routine, Work | 34 | class answers | yes | No routine suggestions |

Measured output:

```text
Labeled: 119 message(s); 111 carry a stored answer.
Important by the labels: 35 (27 answered).
Held by the attention sections: 19 — 70.4% of answered important mail.
Found beyond the first page: 11 (page limit 8).
Attention rows the walk collected: 19.
Misses: 8; routine suggestions: 0.
Important with no stored answer: 8 (the blind spot the coverage line names).
```

All eight misses were explained: five archived, three dismissed. No
unexplained miss existed and no routine mail was suggested, so the run
passed. The paged walk found all 19 answered important inbox rows,
including the 11 that rank past the first page.

The measurement code also has its own tests:
`packages/home/test/evaluation.test.ts` seeds a world where a stored answer
disagrees with the owner and a routine message carries a wrong reply flag.
Both defects fail that run, which proves the two failure paths the
synthetic corpus does not exercise.

## Limits

- The corpus is synthetic. This run validates the measurement and the
  service behavior under pagination, dismissal, and scope. It says nothing
  about real-world selection quality, because the seeder wrote both the
  mail and the labels.
- No owner-labeled run exists yet. Hand-label 100 to 200 of your own
  messages, as the routing gate asks, and record the numbers here before
  trusting the overview.
- Important mail with no stored answer cannot surface. Home makes no model
  call by design. The unanswered count in the report names that gap
  directly; the coverage line on the screen exists for it.
- The walk pages at the client's default limit of eight conversations per
  section. Selection assigns each conversation to its highest section before
  pagination. Each entry includes its related messages, reasons, and open
  work. The client also merges repeated entries if data changes between pages.
