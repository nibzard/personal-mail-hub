#!/usr/bin/env node
/*
 * Task-file validation (T114). `to-do.json` is the machine-readable task
 * list and `to-do.schema.json` is its contract; this command keeps the
 * two, and the plan documents the tasks point at, mutually consistent:
 *
 * - the document satisfies the repository schema, date-time formats
 *   included;
 * - task identifiers are unique, every dependency names a task, no task
 *   depends on itself, and the dependency graph holds no cycle;
 * - every `Plan: <file>` reference names an existing document, and the
 *   anchor or section it names exists in that document (anchors follow
 *   GitHub's heading slugs, through `github-slugger`);
 * - every entry of `source_files` names an existing document;
 * - `files` entries stay repository-relative paths. They may name files
 *   that do not exist yet — a planned implementation file is not a defect
 *   — but they may not reach outside the repository.
 *
 * Every issue names its subject precisely: a field path into the document
 * plus the task identifier when one applies. The report prints to stdout —
 * the release gate logs stdout as the check's log — and the exit status is
 * 0 when the task file is valid, 1 otherwise.
 */
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import GithubSlugger from "github-slugger";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * GitHub's heading slug, through `github-slugger` — the same slugger
 * GitHub's own tooling uses: lower case, punctuation dropped, one hyphen
 * per space.
 */
export function slugifyHeading(text) {
  return new GithubSlugger().slug(text ?? "");
}

/**
 * Every heading anchor a Markdown document exposes: the slug of each ATX
 * heading, with `-1`, `-2`, … appended for repeats, the way GitHub does.
 */
export function collectHeadingAnchors(markdown) {
  const anchors = new Set();
  const slugger = new GithubSlugger();
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading === null) {
      continue;
    }
    const slug = slugger.slug(heading[1]);
    if (slug.length === 0) {
      continue;
    }
    anchors.add(slug);
  }
  return anchors;
}

/** True when the Markdown holds a heading that names this task section. */
export function hasSectionHeading(markdown, sectionId) {
  return markdown.split(/\r?\n/).some((line) => {
    const heading = /^#{1,6}\s+([A-Za-z0-9-]+)\s*:/.exec(line);
    return heading !== null && heading[1] === sectionId;
  });
}

/**
 * The `Plan:` reference in a task's details: `{ file, anchor, section }`,
 * where `anchor` and `section` may be null, or null when the details name
 * no plan. Sentence punctuation that touches the path (a closing period)
 * and backticks around it are not part of the reference.
 */
export function parsePlanReference(details) {
  const match = /(?:^|\n)Plan:\s*(\S+)([^\n]*)/.exec(details ?? "");
  if (match === null) {
    return null;
  }
  const [namedFile, namedAnchor = null] = match[1].replaceAll("`", "").split("#");
  const sectionMatch = /\(\s*section\s+([A-Za-z0-9-]+)/i.exec(match[2] ?? "");
  const anchor = namedAnchor === "" ? null : namedAnchor;
  return {
    file: namedFile.replace(/[.,;:!?]+$/, ""),
    anchor: anchor === null ? null : anchor.replace(/[.,;:!?]+$/, ""),
    section: sectionMatch?.[1] ?? null,
  };
}

/**
 * How an issue names a task: its id in quotes, or its position when the
 * id is missing or not a string (the schema check reports that).
 */
function taskLabel(task, index) {
  return typeof task?.id === "string" ? `"${task.id}"` : `at index ${index} (no id)`;
}

/** Issues for the task graph: duplicate ids and dependency defects. */
export function validateTaskGraph(tasks) {
  const issues = [];
  const byId = new Map();
  tasks.forEach((task, index) => {
    if (typeof task?.id !== "string") {
      return; // The schema check reports the missing id.
    }
    if (byId.has(task.id)) {
      issues.push({
        path: `tasks[${index}]`,
        message: `duplicate task id "${task.id}" (first at index ${byId.get(task.id)})`,
      });
      return;
    }
    byId.set(task.id, index);
  });
  for (const [index, task] of tasks.entries()) {
    const dependencies = Array.isArray(task?.depends_on) ? task.depends_on : [];
    for (const dependency of dependencies) {
      if (dependency === task.id) {
        issues.push({
          path: `tasks[${index}].depends_on`,
          message: `task ${taskLabel(task, index)} depends on itself`,
        });
      } else if (!byId.has(dependency)) {
        issues.push({
          path: `tasks[${index}].depends_on`,
          message: `task ${taskLabel(task, index)} depends on "${dependency}", which no task carries`,
        });
      }
    }
  }
  const cycle = findDependencyCycle(tasks);
  if (cycle !== null) {
    issues.push({
      path: "tasks.depends_on",
      message: `dependency cycle: ${cycle.join(" -> ")}`,
    });
  }
  return issues;
}

/** One dependency cycle as a path of task ids, or null when none exists. */
function findDependencyCycle(tasks) {
  const dependencies = new Map(
    tasks
      .filter((task) => typeof task?.id === "string")
      .map((task) => [
        task.id,
        Array.isArray(task.depends_on) ? task.depends_on.filter((dep) => dep !== task.id) : [],
      ]),
  );
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === "done") {
      return null;
    }
    if (state.get(id) === "visiting") {
      return [...stack.slice(stack.indexOf(id)), id];
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (!dependencies.has(dependency)) {
        continue; // A missing dependency is reported on its own.
      }
      const cycle = visit(dependency);
      if (cycle !== null) {
        return cycle;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const id of dependencies.keys()) {
    const cycle = visit(id);
    if (cycle !== null) {
      return cycle;
    }
  }
  return null;
}

/**
 * Issues for the `Plan:` references: each names an existing document whose
 * headings carry the named anchor or section. `readFile` maps a path to
 * its contents or null when it does not exist.
 */
export function validatePlanLinks(tasks, readFile) {
  const issues = [];
  const documents = new Map();
  const load = (file, path) => {
    if (!documents.has(file)) {
      documents.set(file, readFile(file));
    }
    const contents = documents.get(file);
    if (contents === null || contents === undefined) {
      issues.push({ path, message: `plan document "${file}" does not exist` });
    }
    return contents ?? null;
  };
  tasks.forEach((task, index) => {
    const reference = parsePlanReference(task?.details);
    if (reference === null) {
      return;
    }
    const path = `tasks[${index}].details`;
    const contents = load(reference.file, path);
    if (contents === null) {
      return;
    }
    if (reference.anchor !== null && !collectHeadingAnchors(contents).has(reference.anchor)) {
      issues.push({
        path,
        message: `task ${taskLabel(task, index)} links anchor "#${reference.anchor}", which no heading in "${reference.file}" produces`,
      });
    }
    if (
      reference.section !== null &&
      !hasSectionHeading(contents, reference.section)
    ) {
      issues.push({
        path,
        message: `task ${taskLabel(task, index)} names section ${reference.section}, which no heading in "${reference.file}" starts`,
      });
    }
  });
  return issues;
}

/**
 * Issues for `files` entries: they must be repository-relative paths.
 * Existence is not required — a planned implementation file is legal —
 * but leaving the repository is not.
 */
export function validateFilePaths(tasks) {
  const issues = [];
  tasks.forEach((task, index) => {
    const files = Array.isArray(task?.files) ? task.files : [];
    for (const file of files) {
      if (typeof file !== "string") {
        continue; // The schema check reports the wrong type.
      }
      if (file.length === 0) {
        issues.push({
          path: `tasks[${index}].files`,
          message: `task ${taskLabel(task, index)} lists an empty file path`,
        });
      } else if (file.startsWith("/") || file.match(/^[A-Za-z]:[\\/]/)) {
        issues.push({
          path: `tasks[${index}].files`,
          message: `task ${taskLabel(task, index)} lists the absolute path "${file}"; entries are repository-relative`,
        });
      } else if (file.split(/[\\/]/).includes("..")) {
        issues.push({
          path: `tasks[${index}].files`,
          message: `task ${taskLabel(task, index)} lists "${file}", which climbs out of the repository`,
        });
      }
    }
  });
  return issues;
}

/** A schema checker built once per document: `issues(doc)` lists defects. */
export function createSchemaValidator(schema) {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  return (doc) => {
    if (validate(doc)) {
      return [];
    }
    return (validate.errors ?? []).map((error) => ({
      path: `tasks file${error.instancePath.replace(/\//g, ".")}`,
      message:
        `${error.message ?? "is invalid"}` +
        (error.params?.format !== undefined ? ` (format ${error.params.format})` : "") +
        (error.params?.additionalProperty !== undefined
          ? ` (property "${error.params.additionalProperty}")`
          : ""),
    }));
  };
}

/**
 * Every check in one pass: schema, task graph, plan links, source
 * documents, and file paths. `readFile` exists for tests; the default
 * reads the real repository.
 */
export function validateTodoDocument(
  doc,
  {
    schema,
    readFile = (file) => {
      try {
        return readFileSync(join(repoRoot, file), "utf8");
      } catch {
        return null;
      }
    },
  } = {},
) {
  const issues = [];
  if (schema === undefined) {
    throw new Error("validateTodoDocument: a schema is required");
  }
  issues.push(...createSchemaValidator(schema)(doc));
  // The semantic checks assume arrays; when the schema check already
  // rejected a non-array `tasks` or `source_files`, report only that.
  const tasks = Array.isArray(doc?.tasks) ? doc.tasks : null;
  const sourceFiles = Array.isArray(doc?.source_files) ? doc.source_files : null;
  if (tasks !== null) {
    issues.push(...validateTaskGraph(tasks));
    issues.push(...validatePlanLinks(tasks, readFile));
    issues.push(...validateFilePaths(tasks));
  }
  if (sourceFiles !== null) {
    issues.push(
      ...sourceFiles.flatMap((file) =>
        typeof file === "string" && readFile(file) === null
          ? [{ path: "source_files", message: `source document "${file}" does not exist` }]
          : [],
      ),
    );
  }
  return { ok: issues.length === 0, issues };
}

/*
 * CLI: `node scripts/validate-tasks.mjs [task-file] [schema-file]`.
 */
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const todoPath = process.argv[2] ?? join(repoRoot, "to-do.json");
  const schemaPath = process.argv[3] ?? join(repoRoot, "to-do.schema.json");
  let doc;
  let schema;
  try {
    doc = JSON.parse(readFileSync(todoPath, "utf8"));
  } catch (error) {
    console.error(`task validation: cannot read or parse ${todoPath}: ${error.message}`);
    process.exit(1);
  }
  try {
    schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  } catch (error) {
    console.error(`task validation: cannot read or parse ${schemaPath}: ${error.message}`);
    process.exit(1);
  }
  const { ok, issues } = validateTodoDocument(doc, { schema });
  if (!ok) {
    // The report goes to stdout — the release gate logs stdout as this
    // check's log — while unreadable files stay errors on stderr.
    console.log(`task validation: ${issues.length} issue${issues.length === 1 ? "" : "s"} in ${todoPath}`);
    for (const issue of issues) {
      console.log(`  ${issue.path}: ${issue.message}`);
    }
    process.exit(1);
  }
  const open = (doc.tasks ?? []).filter((task) => task.status === "todo" || task.status === "doing" || task.status === "blocked").length;
  console.log(
    `task validation: ${doc.tasks?.length ?? 0} tasks (${open} open) in ${todoPath} are valid`,
  );
  process.exit(0);
}
