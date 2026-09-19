import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runEvalClassify, type EvalClassifyIO } from "../src/eval-classify.ts";

/**
 * Command behavior only (SPEC section 12): argument handling, label-file
 * reading, and environment checks, all before any database is opened. The
 * measurement itself is covered by the `@mail-hub/classification` suite.
 */

const LABEL_LINE = `{"messageId": "${randomUUID()}", "class": "correspondence"}\n`;

/** Capture everything the command prints. */
function capture(): EvalClassifyIO & { output(): string } {
  let text = "";
  return {
    stdout: (line) => {
      text += line;
    },
    stderr: (line) => {
      text += line;
    },
    output: () => text,
  };
}

async function labelFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mail-hub-eval-"));
  temporaryDirs.push(dir);
  const path = join(dir, "labels.jsonl");
  await writeFile(path, content, "utf8");
  return path;
}

const temporaryDirs: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runEvalClassify", () => {
  it("prints usage and fails without --labels", async () => {
    const io = capture();
    await expect(runEvalClassify([], {}, io)).resolves.toBe(1);
    expect(io.output()).toContain("Usage: npm run eval:classify");
  });

  it("prints usage and fails for a --labels without a value or an unknown flag", async () => {
    await expect(runEvalClassify(["--labels"], {}, capture())).resolves.toBe(1);
    await expect(runEvalClassify(["--labels", "/tmp/x", "--json"], {}, capture())).resolves.toBe(1);
  });

  it("fails when the label file cannot be read", async () => {
    const io = capture();
    await expect(
      runEvalClassify(["--labels", "/nonexistent-labels.jsonl"], { DATABASE_URL: "postgres://localhost/mail" }, io),
    ).resolves.toBe(1);
    expect(io.output()).toContain("could not be read");
  });

  it("fails on an unusable label file before opening any database", async () => {
    const path = await labelFile("{not json\n");
    const io = capture();
    await expect(runEvalClassify(["--labels", path], { DATABASE_URL: "postgres://localhost/mail" }, io)).resolves.toBe(1);
    expect(io.output()).toContain("label file is unusable");
  });

  it("requires DATABASE_URL once the labels parse", async () => {
    const path = await labelFile(LABEL_LINE);
    const io = capture();
    await expect(runEvalClassify(["--labels", path], {}, io)).resolves.toBe(1);
    expect(io.output()).toContain("DATABASE_URL must be set");
  });
});
