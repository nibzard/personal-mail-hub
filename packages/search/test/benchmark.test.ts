import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, dropTestDatabase, runMigrations } from "@mail-hub/database";
import { SearchService, type SearchInput } from "../src/index.ts";

/**
 * The search performance target (SPEC F5 and section 12, milestone 3):
 * full-text search plus operators across all accounts answers under
 * 500 ms p95 at 100 000 messages.
 *
 * Set `TEST_DATABASE_URL` to a connection string whose user may create
 * databases. Without the variable the suite skips. `SEARCH_BENCHMARK_MESSAGES`
 * overrides the corpus size for quick local runs; the default is the target
 * size the milestone names.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const TARGET_P95_MS = 500;
const MESSAGE_COUNT = Number.parseInt(process.env.SEARCH_BENCHMARK_MESSAGES ?? "100000", 10);
const WARMUP_RUNS = 3;
const MEASURED_RUNS = 20;

/** The workload mix: rare and broad text, every operator family, and scope. */
interface Workload {
  label: string;
  input: SearchInput;
}

suite("search benchmark", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let pool: Pool;
  let service: SearchService;
  let workloads: Workload[];

  beforeAll(async () => {
    const admin = new Pool({ connectionString: maintenanceUrl() });
    await admin.query(`create database ${databaseName}`);
    await admin.end();

    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.toString() });
    await runMigrations(pool);
    service = new SearchService(createDatabase(pool), { gateMutation: async () => ({ generation: "bench" }) });

    const accounts = await seedWorld();
    workloads = [
      { label: "rare term", input: { query: "needle phoenix" } },
      { label: "one subject hit", input: { query: "message number 5005" } },
      { label: "broad term (every row)", input: { query: "message" } },
      { label: "sender operator", input: { query: "from:sender42" } },
      { label: "flag operator", input: { query: "message is:unread" } },
      { label: "date range", input: { query: "message after:2023-01-01 before:2024-01-01" } },
      { label: "domain operator", input: { query: "domain:domain3.example" } },
      { label: "classification filters", input: { query: "type:newsletter is:action" } },
      { label: "folder scope", input: { query: "message", folderId: accounts.inboxes[0]! } },
      { label: "combined", input: { query: 'beta "alpha beta" is:flagged has:attachment before:2025-06-01' } },
    ];
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    const admin = new Pool({ connectionString: maintenanceUrl() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  function maintenanceUrl(): string {
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    return url.toString();
  }

  it(`answers under ${TARGET_P95_MS} ms p95 at ${MESSAGE_COUNT} messages`, async () => {
    const samples: { label: string; ms: number }[] = [];

    for (const workload of workloads) {
      for (let run = 0; run < WARMUP_RUNS; run += 1) {
        const result = await service.search(workload.input);
        expect(result.total).toBeGreaterThanOrEqual(0);
      }
      for (let run = 0; run < MEASURED_RUNS; run += 1) {
        const started = performance.now();
        const result = await service.search(workload.input);
        const ms = performance.now() - started;
        expect(result.results.length).toBeLessThanOrEqual(50);
        samples.push({ label: workload.label, ms });
      }
    }

    report(samples);
    const p95 = percentile(samples.map((sample) => sample.ms), 0.95);
    console.log(`search benchmark: p95 ${p95.toFixed(1)} ms across ${samples.length} samples at ${MESSAGE_COUNT} messages`);
    expect(p95).toBeLessThanOrEqual(TARGET_P95_MS);
  }, 240_000);

  /** Seed the corpus: three accounts, one inbox each, plus one archive. */
  async function seedWorld(): Promise<{ inboxes: string[] }> {
    const accountIds: string[] = [];
    const inboxes: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const account = await pool.query(
        `insert into accounts (label, color, username, password_enc) values ($1,'#111111',$2,'v1:ct') returning id`,
        [`bench-${index}`, `bench-${index}@hub.example`],
      );
      accountIds.push(account.rows[0]!.id as string);
      const folder = await pool.query(
        `insert into folders (account_id, name, role, uidvalidity) values ($1,$2,'inbox',1) returning id`,
        [accountIds[index]!, index === 0 ? "INBOX" : `INBOX-${index}`],
      );
      inboxes.push(folder.rows[0]!.id as string);
    }

    await pool.query(
      `insert into messages (
         account_id, sender_text, sender, subject, subject_text, body_index_text, fetched_body,
         sent_at, has_attachments, class_hint, asks_action, thread_link_state, thread_dirty
       )
       select a.id,
         'sender' || (g.i % 200) || ' person' || (g.i % 200) || '@domain' || (g.i % 5) || '.example',
         jsonb_build_object(
           'address', 'sender' || (g.i % 200) || '@domain' || (g.i % 5) || '.example',
           'name', 'Person ' || (g.i % 200)
         ),
         'Message number ' || g.i,
         'message number ' || g.i,
         case when g.i % 1000 = 0
           then 'needle phoenix report ' || g.i
           else 'alpha beta gamma delta epsilon zeta eta theta iota ' || (g.i % 97) || ' more words follow'
         end,
         g.i % 1000 <> 0,
         timestamptz '2020-01-01 00:00:00+00' + ((g.i % 2200) || ' days')::interval,
         g.i % 10 = 0,
         case when g.i % 50 = 0 then 'newsletter' else null end,
         g.i % 50 = 0,
         'root',
         false
       from generate_series(1, $1) as g(i)
       join (values ($2::uuid, 0), ($3::uuid, 1), ($4::uuid, 2)) as a(id, n) on a.n = g.i % 3`,
      [MESSAGE_COUNT, accountIds[0]!, accountIds[1]!, accountIds[2]!],
    );

    await pool.query(
      `insert into message_occurrences (
         account_id, message_id, folder_id, uidvalidity, uid, internal_date, unread, flagged
       )
       select m.account_id, m.id, f.id, 1, g.i, m.sent_at + interval '1 minute', g.i % 3 = 0, g.i % 7 = 0
       from generate_series(1, $1) as g(i)
       join messages m on m.subject_text = 'message number ' || g.i
       join (values ($2::uuid, 0), ($3::uuid, 1), ($4::uuid, 2)) as f(id, n) on f.n = g.i % 3`,
      [MESSAGE_COUNT, inboxes[0]!, inboxes[1]!, inboxes[2]!],
    );

    await pool.query(`analyze messages`);
    await pool.query(`analyze message_occurrences`);
    return { inboxes };
  }
});

/** Print one line per workload so slow shapes are visible in the log. */
function report(samples: { label: string; ms: number }[]): void {
  const byLabel = new Map<string, number[]>();
  for (const sample of samples) {
    byLabel.set(sample.label, [...(byLabel.get(sample.label) ?? []), sample.ms]);
  }
  for (const [label, times] of byLabel) {
    const median = percentile(times, 0.5);
    const p95 = percentile(times, 0.95);
    console.log(`  ${label.padEnd(26)} median ${median.toFixed(1)} ms   p95 ${p95.toFixed(1)} ms`);
  }
}

/** The value at `fraction` of the sorted samples; the highest below it. */
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index]!;
}
