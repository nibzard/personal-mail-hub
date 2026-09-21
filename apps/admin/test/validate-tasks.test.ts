import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The validator is a plain Node script, so it carries no type
// declarations; the pure surface under test is pinned here.
// @ts-expect-error No declaration file for the script.
import { collectHeadingAnchors, createSchemaValidator, hasSectionHeading, parsePlanReference, slugifyHeading, validateFilePaths, validatePlanLinks, validateTaskGraph, validateTodoDocument } from "../../../scripts/validate-tasks.mjs";

/*
 * Task-file validation contracts (T114): a clean checkout passes, and each
 * defect a maintainer can introduce — a schema drift, a broken dependency,
 * a stale plan link — fails with a precise subject.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Reads repository files; the plan-link tests inject their own. */
function repoRead(file: string): string | null {
  try {
    return readFileSync(join(repoRoot, file), "utf8");
  } catch {
    return null;
  }
}

const realSchema = JSON.parse(readFileSync(join(repoRoot, "to-do.schema.json"), "utf8"));

/** One valid document the fixtures mutate. */
function baseDoc(): Record<string, unknown> {
  return {
    schema_version: 1,
    source_files: ["docs/plan.md"],
    tasks: [
      {
        id: "T1",
        title: "One",
        priority: 2,
        status: "todo",
        details: "Plan: docs/plan.md#t1-one",
        depends_on: [],
      },
    ],
  };
}

/** A readFile stub over one in-memory document. */
function overDocuments(documents: Record<string, string>) {
  return (file: string) => documents[file] ?? null;
}

describe("the repository's own task file", () => {
  it("validates clean: list, schema, plan links, and source documents", () => {
    const doc = JSON.parse(readFileSync(join(repoRoot, "to-do.json"), "utf8"));
    const verdict = validateTodoDocument(doc, { schema: realSchema, readFile: repoRead });
    expect(verdict.issues).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});

describe("schema checks", () => {
  it("accepts the base fixture, notes and optional fields included", () => {
    const tasks = validateTodoDocument(baseDoc(), {
      schema: realSchema,
      readFile: overDocuments({ "docs/plan.md": "## T1: One\n" }),
    });
    expect(tasks.issues).toEqual([]);
  });

  it("names the field path of a missing required property", () => {
    const doc = baseDoc() as { tasks: Array<Record<string, unknown>> };
    delete doc.tasks[0]!.title;
    const issues = createSchemaValidator(realSchema)(doc);
    expect(issues.some((issue: { path: string; message: string }) => issue.path === "tasks file.tasks.0" && /must have required property 'title'/.test(issue.message))).toBe(true);
  });

  it("reports a value outside the status enum at its field path", () => {
    const doc = baseDoc() as { tasks: Array<Record<string, unknown>> };
    doc.tasks[0]!.status = "finished";
    const issues = createSchemaValidator(realSchema)(doc);
    expect(issues.some((issue: { path: string }) => issue.path === "tasks file.tasks.0.status")).toBe(true);
  });

  it("reports a malformed date-time with its format", () => {
    const doc = baseDoc() as { tasks: Array<Record<string, unknown>> };
    doc.tasks[0]!.updated_at = "21.09.2026";
    const issues = createSchemaValidator(realSchema)(doc);
    expect(issues.some((issue: { message: string }) => /date-time/.test(issue.message))).toBe(true);
  });

  it("rejects a property the schema does not carry", () => {
    const doc = baseDoc() as { tasks: Array<Record<string, unknown>> };
    doc.tasks[0]!.assignee = "someone";
    const issues = createSchemaValidator(realSchema)(doc);
    expect(issues.some((issue: { message: string }) => /assignee/.test(issue.message))).toBe(true);
  });
});

describe("task graph checks", () => {
  it("rejects a duplicate identifier with both indexes named", () => {
    const doc = baseDoc() as { tasks: Array<Record<string, unknown>> };
    doc.tasks.push({ ...doc.tasks[0]! });
    const issues = validateTaskGraph(doc.tasks);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("tasks[1]");
    expect(issues[0].message).toMatch(/duplicate task id "T1".*first at index 0/);
  });

  it("rejects a dependency no task carries", () => {
    const doc = baseDoc() as { tasks: Array<Record<string, unknown>> };
    doc.tasks[0]!.depends_on = ["T9"];
    const issues = validateTaskGraph(doc.tasks);
    expect(issues[0].message).toMatch(/"T1" depends on "T9", which no task carries/);
  });

  it("rejects a self-dependency", () => {
    const doc = baseDoc() as { tasks: Array<Record<string, unknown>> };
    doc.tasks[0]!.depends_on = ["T1"];
    const issues = validateTaskGraph(doc.tasks);
    expect(issues[0].message).toMatch(/"T1" depends on itself/);
  });

  it("names a task without an id by its index, not as undefined", () => {
    const tasks = [{ title: "No id", depends_on: ["T9"] }];
    const issues = validateTaskGraph(tasks);
    expect(issues[0].message).toMatch(/at index 0 \(no id\) depends on "T9"/);
  });

  it("rejects a two-task cycle with the path spelled out", () => {
    const tasks = [
      { id: "A", depends_on: ["B"] },
      { id: "B", depends_on: ["A"] },
    ];
    const issues = validateTaskGraph(tasks);
    expect(issues.some((issue: { message: string }) => /cycle: A -> B -> A|cycle: B -> A -> B/.test(issue.message))).toBe(true);
  });

  it("rejects a cycle that only some tasks join", () => {
    const tasks = [
      { id: "A", depends_on: [] },
      { id: "B", depends_on: ["C"] },
      { id: "C", depends_on: ["B"] },
      { id: "D", depends_on: ["B", "A"] },
    ];
    const issues = validateTaskGraph(tasks);
    expect(issues.some((issue: { message: string }) => /cycle: (B -> C -> B|C -> B -> C)/.test(issue.message))).toBe(true);
  });
});

describe("heading anchors", () => {
  it("slugs headings the way GitHub does", () => {
    expect(slugifyHeading("T114: Validate task files automatically")).toBe(
      "t114-validate-task-files-automatically",
    );
    expect(slugifyHeading("What's new? (2026)")).toBe("whats-new-2026");
    // An em dash is dropped, not folded: the spaces around it each become
    // a hyphen, and a run of spaces keeps one hyphen per space.
    expect(slugifyHeading("Foo — Bar")).toBe("foo--bar");
    expect(slugifyHeading("Keep   spaces")).toBe("keep---spaces");
  });

  it("numbers repeated headings", () => {
    const anchors = collectHeadingAnchors("## Setup\n\n# Setup\n\n### Setup\n");
    expect([...anchors].sort()).toEqual(["setup", "setup-1", "setup-2"]);
  });

  it("finds section headings by task identifier", () => {
    const markdown = "## T107: Deploy sync fixes\n\nBody.\n";
    expect(hasSectionHeading(markdown, "T107")).toBe(true);
    expect(hasSectionHeading(markdown, "T999")).toBe(false);
  });
});

describe("plan references", () => {
  it("parses anchor, section, and bare forms", () => {
    expect(parsePlanReference("Plan: docs/a.md#t1-one\n\nBody")).toEqual({
      file: "docs/a.md",
      anchor: "t1-one",
      section: null,
    });
    expect(parsePlanReference("Plan: docs/a.md (section T107).")).toEqual({
      file: "docs/a.md",
      anchor: null,
      section: "T107",
    });
    expect(parsePlanReference("Plan: docs/a.md")).toEqual({
      file: "docs/a.md",
      anchor: null,
      section: null,
    });
    expect(parsePlanReference("Plan: docs/a.md.")).toEqual({
      file: "docs/a.md",
      anchor: null,
      section: null,
    });
    expect(parsePlanReference("Plan: `docs/a.md`#t1-one.")).toEqual({
      file: "docs/a.md",
      anchor: "t1-one",
      section: null,
    });
    expect(parsePlanReference("No plan here.")).toBeNull();
  });

  it("accepts an anchor the plan document produces", () => {
    const tasks = [{ id: "T1", details: "Plan: docs/plan.md#t1-one" }];
    expect(validatePlanLinks(tasks, overDocuments({ "docs/plan.md": "## T1: One\n" }))).toEqual([]);
  });

  it("accepts a repeated heading through its numbered anchor", () => {
    const tasks = [{ id: "T1", details: "Plan: docs/plan.md#setup-1" }];
    const documents = overDocuments({ "docs/plan.md": "## Setup\n\n## Setup\n\n## Setup\n" });
    expect(validatePlanLinks(tasks, documents)).toEqual([]);
  });

  it("rejects a repeat suffix the document's headings do not reach", () => {
    const tasks = [{ id: "T1", details: "Plan: docs/plan.md#setup-2" }];
    const documents = overDocuments({ "docs/plan.md": "## Setup\n\n## Setup\n" });
    expect(validatePlanLinks(tasks, documents)[0].message).toMatch(/#setup-2/);
  });

  it("names the task and the anchor a document lacks", () => {
    const tasks = [{ id: "T2", details: "Plan: docs/plan.md#t2-two" }];
    const issues = validatePlanLinks(tasks, overDocuments({ "docs/plan.md": "## T1: One\n" }));
    expect(issues[0].path).toBe("tasks[0].details");
    expect(issues[0].message).toMatch(/"T2" links anchor "#t2-two".*"docs\/plan\.md"/);
  });

  it("reports a plan document that does not exist", () => {
    const tasks = [{ id: "T1", details: "Plan: docs/absent.md#t1-one" }];
    const issues = validatePlanLinks(tasks, overDocuments({}));
    expect(issues[0].message).toMatch(/"docs\/absent\.md" does not exist/);
  });

  it("checks a named section against the document's headings", () => {
    const tasks = [{ id: "T1", details: "Plan: docs/plan.md (section T7)." }];
    const documents = overDocuments({ "docs/plan.md": "## T1: One\n" });
    expect(validatePlanLinks(tasks, documents)[0].message).toMatch(/section T7/);
  });
});

describe("file path checks", () => {
  it("accepts a planned file that does not exist yet", () => {
    const tasks = [{ id: "T1", files: ["packages/harness/src/future.ts"] }];
    expect(validateFilePaths(tasks)).toEqual([]);
  });

  it("rejects absolute paths and paths that leave the repository", () => {
    const tasks = [
      { id: "T1", files: ["/etc/passwd"] },
      { id: "T2", files: ["../outside.ts"] },
      { id: "T3", files: ["docs/../../outside.ts"] },
      { id: "T4", files: [""] },
    ];
    const issues = validateFilePaths(tasks);
    expect(issues).toHaveLength(4);
    expect(issues.map((issue: { path: string }) => issue.path)).toEqual([
      "tasks[0].files",
      "tasks[1].files",
      "tasks[2].files",
      "tasks[3].files",
    ]);
  });
});

describe("source documents", () => {
  it("rejects a source document that does not exist", () => {
    const doc = baseDoc() as { source_files: string[] };
    doc.source_files = ["docs/absent.md"];
    const { issues } = validateTodoDocument(doc, {
      schema: realSchema,
      readFile: overDocuments({}),
    });
    expect(issues.some((issue: { path: string; message: string }) => issue.path === "source_files" && /docs\/absent\.md/.test(issue.message))).toBe(true);
  });
});

describe("malformed shapes", () => {
  // A hand edit can put a scalar where a list belongs one level below the
  // arrays; the validator reports the schema issue and never crashes.
  function check(mutate: (doc: Record<string, unknown>) => void): { ok: boolean; issues: Array<{ path: string; message: string }> } {
    const doc = baseDoc();
    mutate(doc);
    return validateTodoDocument(doc, {
      schema: realSchema,
      readFile: overDocuments({ "docs/plan.md": "## T1: One\n" }),
    });
  }

  it("reports a non-string files entry instead of throwing", () => {
    const result = check((doc) => {
      (doc.tasks as Array<Record<string, unknown>>)[0]!.files = [42];
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue: { path: string }) => issue.path === "tasks file.tasks.0.files.0")).toBe(true);
  });

  it("reports a scalar files field instead of throwing", () => {
    const result = check((doc) => {
      (doc.tasks as Array<Record<string, unknown>>)[0]!.files = 7;
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue: { path: string }) => issue.path === "tasks file.tasks.0.files")).toBe(true);
  });

  it("reports a scalar depends_on field instead of throwing", () => {
    const result = check((doc) => {
      (doc.tasks as Array<Record<string, unknown>>)[0]!.depends_on = 5;
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue: { path: string }) => issue.path === "tasks file.tasks.0.depends_on")).toBe(true);
  });

  it("reports a string depends_on field, which is iterable, without a crash in the cycle walk", () => {
    const result = check((doc) => {
      (doc.tasks as Array<Record<string, unknown>>)[0]!.depends_on = "T9";
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue: { path: string }) => issue.path === "tasks file.tasks.0.depends_on")).toBe(true);
  });

  it("reports a non-array tasks field without a crash", () => {
    const doc = { schema_version: 1, source_files: [], tasks: "stuff" };
    const { ok, issues } = validateTodoDocument(doc, { schema: realSchema, readFile: overDocuments({}) });
    expect(ok).toBe(false);
    expect(issues.some((issue: { path: string }) => /tasks/.test(issue.path))).toBe(true);
  });

  it("reports a non-array source_files field without a crash", () => {
    const doc = { schema_version: 1, source_files: 7, tasks: [] };
    const { ok, issues } = validateTodoDocument(doc, { schema: realSchema, readFile: overDocuments({}) });
    expect(ok).toBe(false);
    expect(issues.some((issue: { path: string }) => /source_files/.test(issue.path))).toBe(true);
  });
});

describe("the command line", () => {
  // The release gate and `npm run validate:tasks` run the CLI, not the
  // module API, so its entry guard, streams, and exit codes run here too.
  const script = fileURLToPath(new URL("../../../scripts/validate-tasks.mjs", import.meta.url));

  /** Runs the CLI and captures its streams and exit status. */
  function runCli(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout?.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        err += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, out, err }));
    });
  }

  it("exits 0 and summarizes the repository's own task file", async () => {
    const exit = await runCli([]);
    expect(exit.code).toBe(0);
    expect(exit.out).toMatch(/task validation: \d+ tasks \(\d+ open\) in .*to-do\.json are valid/);
  });

  it("exits 1 and prints each issue on stdout for a broken task file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "validate-tasks-"));
    try {
      const broken = join(dir, "to-do.json");
      await writeFile(
        broken,
        JSON.stringify({
          schema_version: 1,
          source_files: ["AGENTS.md"],
          tasks: [
            {
              id: "X1",
              title: "Broken",
              priority: 2,
              status: "todo",
              details: "",
              depends_on: ["NOPE"],
            },
          ],
        }),
      );
      const exit = await runCli([broken, join(repoRoot, "to-do.schema.json")]);
      expect(exit.code).toBe(1);
      // The report lands on stdout: the release gate logs stdout as this
      // check's log, so the log it advertises holds the reasons.
      expect(exit.out).toMatch(/tasks\[0\]\.depends_on: task "X1" depends on "NOPE"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 with a stderr note for an unreadable task file", async () => {
    const exit = await runCli([join(tmpdir(), "absent-to-do.json")]);
    expect(exit.code).toBe(1);
    expect(exit.err).toMatch(/cannot read or parse/);
  });
});
