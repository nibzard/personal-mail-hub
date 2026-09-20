import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runEvalHome, type EvalHomeIO } from "../src/eval-home.ts";

/**
 * Command behavior only (SPEC F13, plan step 7): argument handling,
 * label-file reading, and the environment check, all before any database is
 * opened. The measurement itself is covered by the `@mail-hub/home` suite.
 */

const LABEL_LINE = `{"messageId": "${randomUUID()}", "class": "correspondence"}\n`;

/** Capture everything the command prints. */
function capture(): EvalHomeIO & { output(): string } {
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
  const dir = await mkdtemp(join(tmpdir(), "mail-hub-eval-home-"));
  temporaryDirs.push(dir);
  const path = join(dir, "labels.jsonl");
  await writeFile(path, content, "utf8");
  return path;
}

const temporaryDirs: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runEvalHome", () => {
  it("prints usage and fails without --labels", async () => {
    const io = capture();
    await expect(runEvalHome([], {}, io)).resolves.toBe(1);
    expect(io.output()).toContain("Usage: npm run eval:home");
  });

  it("prints usage and fails for a --labels without a value or an unknown flag", async () => {
    await expect(runEvalHome(["--labels"], {}, capture())).resolves.toBe(1);
    await expect(runEvalHome(["--labels", "/tmp/x", "--json"], {}, capture())).resolves.toBe(1);
  });

  it("fails when the label file cannot be read", async () => {
    const io = capture();
    await expect(
      runEvalHome(["--labels", "/nonexistent-labels.jsonl"], { DATABASE_URL: "postgres://localhost/mail" }, io),
    ).resolves.toBe(1);
    expect(io.output()).toContain("could not be read");
  });

  it("fails on an unusable label file before opening any database", async () => {
    const path = await labelFile("{not json\n");
    const io = capture();
    await expect(runEvalHome(["--labels", path], { DATABASE_URL: "postgres://localhost/mail" }, io)).resolves.toBe(1);
    expect(io.output()).toContain("label file is unusable");
  });

  it("requires DATABASE_URL once the labels parse", async () => {
    const path = await labelFile(LABEL_LINE);
    const io = capture();
    await expect(runEvalHome(["--labels", path], {}, io)).resolves.toBe(1);
    expect(io.output()).toContain("DATABASE_URL must be set");
  });
});
