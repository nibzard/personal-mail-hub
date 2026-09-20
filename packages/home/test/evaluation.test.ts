import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  dropTestDatabase,
  runMigrations,
  type MailHubDatabase,
} from "@mail-hub/database";
import type { MutationGate } from "@mail-hub/recovery";
import {
  evaluateHome,
  HomeError,
  HomeService,
  parseHomeLabels,
  type HomeLabel,
} from "../src/index.ts";

/**
 * The Home selection evaluation (SPEC F13, plan step 7) against a real
 * PostgreSQL: the paged walk finds important mail beyond the first page,
 * owner-chosen and scope-chosen absences are explained rather than failed,
 * a stored answer that disagrees with the owner fails the run, and routine
 * mail the attention sections suggest is a defect. Set `TEST_DATABASE_URL`
 * to a connection string whose user may create databases; a throwaway
 * database is created per run. Without the variable the DB suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const NOW = new Date("2026-09-20T12:00:00Z");

/** The gate reads never reach; every mutation here goes through raw SQL. */
const READ_ONLY_GATE: MutationGate = {
  async gateMutation(): Promise<{ generation: string }> {
    throw new Error("The evaluation never mutates.");
  },
};

describe("parseHomeLabels", () => {
  it("parses labels with comments, blank lines, and optional flags", () => {
    const id = randomUUID();
    const labels = parseHomeLabels(
      `# One hand label per line.\n` +
        `\n` +
        `{"messageId": "${id}", "class": "correspondence", "asksReply": true}\n` +
        `{"messageId": "${randomUUID()}", "class": "security_alert"}\n`,
    );
    expect(labels).toHaveLength(2);
    expect(labels[0]).toEqual({ messageId: id, classHint: "correspondence", asksReply: true });
    expect(labels[1]).toEqual({ messageId: labels[1]!.messageId, classHint: "security_alert" });
  });

  it("rejects the same typo the classification labels reject", async () => {
    const cases = [
      "{not json\n",
      `{"messageId": "${randomUUID()}"}\n`,
      `{"messageId": "${randomUUID()}", "class": "urgent"}\n`,
      `{"messageId": "not-a-uuid", "class": "other"}\n`,
      `{"messageId": "${randomUUID()}", "class": "other", "urgent": true}\n`,
      `{"messageId": "${randomUUID()}", "class": "other", "asksAction": "yes"}\n`,
      `{"messageId": "${randomUUID()}", "class": "other"}\n{"messageId": "${randomUUID()}", "class": "receipt"}\n[]\n`,
      "# Only a comment.\n",
    ];
    for (const text of cases) {
      const rejection = await expectRejection(() => parseHomeLabels(text));
      expect(rejection.code).toBe("invalid_request");
    }
  });
});

suite("evaluateHome", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let pool: Pool;
  let db: MailHubDatabase;
  let service: HomeService;

  // The seeded world.
  let account: string;
  let inbox: string;
  let archive: string;
  const ids = new Map<string, string>();

  beforeAll(async () => {
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await admin.query(`create database ${databaseName}`);
    await admin.end();

    url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.toString() });
    await runMigrations(pool);
    db = createDatabase(pool);
    service = new HomeService(db, READ_ONLY_GATE, {
      settings: {
        readSettings: async () => ({
          theme: "system",
          density: "compact",
          singleKeyShortcuts: true,
          cleanViewDefault: false,
          classificationEnabled: true,
          homeEnabled: true,
          classificationMonthlyCostCapUsd: null,
          backfillClassification: false,
        }),
      },
      circuit: {
        readCircuit: async () => ({ circuit: "closed", description: "Classification is running." }),
      },
      now: () => NOW,
    });

    const result = await pool.query(
      `insert into accounts (label, color, username, password_enc) values ('Main','#2563eb','main@hub.example','v1:ct') returning id`,
    );
    account = result.rows[0]!.id as string;
    inbox = await seedFolder("INBOX", "inbox");
    archive = await seedFolder("Archive", "archive");

    // Nine attention-eligible rows, so Needs attention paginates at the
    // client's page size of eight. The oldest one ranks on page two.
    for (let index = 0; index < 7; index += 1) {
      await seed(`filler${index}`, {
        folder: inbox,
        sentAt: `2026-09-0${index + 2}T09:00:00Z`,
        asksReply: true,
        classSource: "jev",
      });
    }
    await seed("routineTrap", {
      folder: inbox,
      sentAt: "2026-09-10T09:00:00Z",
      asksReply: true,
      classSource: "jev",
    });
    await seed("page2Important", {
      folder: inbox,
      sentAt: "2026-09-01T09:00:00Z",
      asksReply: true,
      classSource: "jev",
    });

    // Absences the owner or the scope explains.
    await seed("dismissedImportant", {
      folder: inbox,
      sentAt: "2026-09-11T09:00:00Z",
      asksAction: true,
      classSource: "jev",
    });
    await pool.query(`insert into home_dismissals (account_id, message_id) values ($1,$2)`, [
      account,
      ids.get("dismissedImportant"),
    ]);
    await seed("archivedImportant", {
      folder: archive,
      sentAt: "2026-09-12T09:00:00Z",
      asksAction: true,
      classSource: "jev",
    });

    // The two defects this evaluation exists to catch: a stored answer that
    // disagrees with the owner, and routine mail suggested anyway.
    await seed("disagreedImportant", {
      folder: inbox,
      sentAt: "2026-09-13T09:00:00Z",
      classHint: "receipt",
    });
    await seed("unansweredImportant", {
      folder: inbox,
      sentAt: "2026-09-14T09:00:00Z",
    });

    // Routine mail the owner starred: Saved holds it by choice, and the
    // attention sections never see it.
    await seed("starredRoutine", {
      folder: inbox,
      sentAt: "2026-09-15T09:00:00Z",
      classHint: "newsletter",
      flagged: true,
    });
  });

  afterAll(async () => {
    await pool?.end();
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  async function seedFolder(name: string, role: string): Promise<string> {
    const result = await pool.query(
      `insert into folders (account_id, name, role, uidvalidity) values ($1,$2,$3,1) returning id`,
      [account, name, role],
    );
    return result.rows[0]!.id as string;
  }

  /** Seed one message with an occurrence; the arrival time equals the send time. */
  async function seed(
    key: string,
    input: {
      folder: string;
      sentAt: string;
      classHint?: string;
      classSource?: string;
      asksAction?: boolean;
      asksReply?: boolean;
      flagged?: boolean;
    },
  ): Promise<void> {
    const inserted = await pool.query(
      `insert into messages (
         account_id, thread_id, subject, sender, sent_at, ingested_at, snippet,
         class_hint, asks_action, asks_reply, time_sensitive,
         metadata, thread_link_state, thread_dirty
       ) values ($1,null,$2,$3,$4,$4,$5,$6,$7,$8,null,$9,'root',false) returning id`,
      [
        account,
        `Message ${key}`,
        JSON.stringify({ address: `${key}@example.com`, name: null }),
        input.sentAt,
        `Snippet of ${key}`,
        input.classHint ?? null,
        input.asksAction ?? null,
        input.asksReply ?? null,
        input.classSource === undefined ? {} : JSON.stringify({ classSource: input.classSource }),
      ],
    );
    const id = inserted.rows[0]!.id as string;
    ids.set(key, id);
    await pool.query(
      `insert into message_occurrences (account_id, message_id, folder_id, uidvalidity, uid, internal_date, unread, flagged)
       values ($1,$2,$3,1,(select coalesce(max(uid),0)+1 from message_occurrences where folder_id = $3),$4,false,$5)`,
      [account, id, input.folder, input.sentAt, input.flagged ?? false],
    );
  }

  function id(key: string): string {
    return ids.get(key)!;
  }

  /** The label set over the seeded world, as the owner would hand it. */
  function labels(): HomeLabel[] {
    return [
      { messageId: id("filler0"), classHint: "correspondence", asksReply: true },
      { messageId: id("filler1"), classHint: "correspondence", asksReply: true },
      { messageId: id("page2Important"), classHint: "correspondence", asksReply: true },
      { messageId: id("routineTrap"), classHint: "newsletter" },
      { messageId: id("starredRoutine"), classHint: "newsletter" },
      { messageId: id("dismissedImportant"), classHint: "correspondence", asksAction: true },
      { messageId: id("archivedImportant"), classHint: "correspondence", asksAction: true },
      { messageId: id("disagreedImportant"), classHint: "correspondence", asksAction: true },
      { messageId: id("unansweredImportant"), classHint: "security_alert" },
    ];
  }

  it("fails on a label naming a message that is not stored", async () => {
    const rejection = await expectRejection(() =>
      evaluateHome(db, service, [{ messageId: randomUUID(), classHint: "other" }]),
    );
    expect(rejection.code).toBe("invalid_request");
    expect(rejection.message).toContain("not stored");
  });

  it("measures coverage, explained absences, and the two defect kinds", async () => {
    const evaluation = await evaluateHome(db, service, labels());

    // Every label names stored mail; all but the unanswered one carry an
    // answer Home can read.
    expect(evaluation.labeled).toBe(9);
    expect(evaluation.answered).toBe(8);

    // Important by the labels: fillers 0 and 1, page 2, the dismissed, the
    // archived, the disagreed, and the unanswered one.
    expect(evaluation.importantLabeled).toBe(7);
    expect(evaluation.importantAnswered).toBe(6);
    expect(evaluation.importantUnanswered).toHaveLength(1);
    expect(evaluation.importantUnanswered[0]!.messageId).toBe(id("unansweredImportant"));
    expect(evaluation.importantUnanswered[0]!.sender).toBe("unansweredimportant@example.com");

    // The paged walk reaches the row that ranks past the first page.
    expect(evaluation.importantPresent).toBe(3);
    expect(evaluation.importantBeyondFirstPage).toBe(1);
    expect(evaluation.attentionRows).toBe(9);
    expect(evaluation.pageLimit).toBe(8);

    // The misses split into explained and unexplained.
    expect(evaluation.attentionMisses).toHaveLength(3);
    const byStatus = new Map(evaluation.attentionMisses.map((miss) => [miss.status, miss]));
    expect(byStatus.get("dismissed")!.messageId).toBe(id("dismissedImportant"));
    expect(byStatus.get("outside_inbox")!.messageId).toBe(id("archivedImportant"));
    const unexplained = byStatus.get("no_attention_signal")!;
    expect(unexplained.messageId).toBe(id("disagreedImportant"));
    expect(unexplained.stored.classHint).toBe("receipt");
    expect(unexplained.labeled.asksAction).toBe(true);

    // The stored answer suggested a routine message; the starred one never
    // entered the attention sections, so it is not accused.
    expect(evaluation.routineSuggestions).toHaveLength(1);
    expect(evaluation.routineSuggestions[0]!.messageId).toBe(id("routineTrap"));
    expect(evaluation.routineSuggestions[0]!.labeledClassHint).toBe("newsletter");
    expect(evaluation.routineSuggestions[0]!.reasonCodes).toContain("may_need_reply");

    // The unexplained miss and the routine suggestion both fail the run.
    expect(evaluation.passed).toBe(false);
  });

  it("passes a world whose only absences are explained", async () => {
    // Drop the two defects from the label set: the disagreed message and the
    // routine trap. What remains is present, explained, or unanswered.
    const kept = labels().filter(
      (label) => label.messageId !== id("disagreedImportant") && label.messageId !== id("routineTrap"),
    );
    const evaluation = await evaluateHome(db, service, kept);
    expect(evaluation.attentionMisses.map((miss) => miss.status).sort()).toEqual([
      "dismissed",
      "outside_inbox",
    ]);
    expect(evaluation.routineSuggestions).toHaveLength(0);
    expect(evaluation.passed).toBe(true);
  });
});

/** Convert a throw into the Home rejection it produced. */
async function expectRejection(
  run: () => unknown,
): Promise<HomeError & { code: string; message: string }> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HomeError) {
      return error;
    }
    throw error;
  }
  throw new Error("The call was expected to reject, but it resolved.");
}
