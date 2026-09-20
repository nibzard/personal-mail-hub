import { describe, expect, it } from "vitest";
import { StorageError } from "@mail-hub/database";
import { IngestionError } from "@mail-hub/ingestion";
import { classifyFailure, UNKNOWN_FAILURE_KIND } from "../src/diagnostics.ts";
import { SyncError } from "../src/errors.ts";

/*
 * Safe failure classification (docs/sync-repair-plan.md T104). Error text is
 * never serialized: a database error repeats its query parameters, and a
 * thrown value can be anything. Every kind must come from the approved
 * vocabularies and fit the kind shape, and no private sentinel planted in
 * messages, names, stacks, or codes may reach a classification.
 */

/** A value no diagnostic may ever emit. */
const SENTINEL = "SENTINEL-private-7f3a1";

/** A PostgreSQL UTF8 fault of the incident family, carrying private detail. */
function utf8Fault(): Error {
  return Object.assign(
    new Error(`invalid byte sequence for encoding "UTF8": 0x00 — ${SENTINEL}`),
    { code: "22021" },
  );
}

/** The query-wrapper shape drizzle raises around a database fault. */
function wrappedFault(): Error {
  return Object.assign(new Error(`Failed query: insert into messages … ${SENTINEL}`), {
    cause: utf8Fault(),
  });
}

describe("classifyFailure", () => {
  it("answers the sync error code", () => {
    expect(classifyFailure(new SyncError("mailbox_error", `SELECT failed ${SENTINEL}`))).toBe("mailbox_error");
    expect(classifyFailure(new SyncError("generation_changed", SENTINEL))).toBe("generation_changed");
  });

  it("prefixes storage and ingestion codes", () => {
    expect(classifyFailure(new StorageError("insufficient_space", SENTINEL))).toBe("storage_insufficient_space");
    expect(classifyFailure(new StorageError("io_failed", SENTINEL))).toBe("storage_io_failed");
    expect(classifyFailure(new IngestionError("parse_failed", SENTINEL))).toBe("ingestion_parse_failed");
    expect(
      classifyFailure(new IngestionError("message_too_large", SENTINEL, 52428801)),
    ).toBe("ingestion_message_too_large");
  });

  it("reads a SQLSTATE from a nested database cause", () => {
    expect(classifyFailure(wrappedFault())).toBe("database_22021");
  });

  it("reads a SQLSTATE from an aggregate of faults", () => {
    const aggregate = new AggregateError([utf8Fault()], `aggregate ${SENTINEL}`);
    expect(classifyFailure(aggregate)).toBe("database_22021");
  });

  it("reads errno codes from system faults", () => {
    const refused = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:5432 ${SENTINEL}`), {
      code: "ECONNREFUSED",
    });
    expect(classifyFailure(refused)).toBe("system_econnrefused");
  });

  it("keeps five-letter errno codes out of the database family", () => {
    // EPIPE, EPERM, EBUSY, EINTR, ESRCH, and EBADF match the SQLSTATE shape
    // in length and case; only the digit requirement tells them apart.
    const pipe = Object.assign(new Error(`write EPIPE ${SENTINEL}`), { code: "EPIPE" });
    expect(classifyFailure(pipe)).toBe("system_epipe");
    const denied = Object.assign(new Error(`open EPERM ${SENTINEL}`), { code: "EPERM" });
    expect(classifyFailure(denied)).toBe("system_eperm");
    const busy = Object.assign(new Error(`open EBUSY ${SENTINEL}`), { code: "EBUSY" });
    expect(classifyFailure(busy)).toBe("system_ebusy");
  });

  it("reads letter-led SQLSTATE codes as database faults", () => {
    const raised = Object.assign(new Error(`raise exception ${SENTINEL}`), { code: "P0001" });
    expect(classifyFailure(raised)).toBe("database_p0001");
    const internal = Object.assign(new Error(`internal error ${SENTINEL}`), { code: "XX001" });
    expect(classifyFailure(internal)).toBe("database_xx001");
  });

  it("reads a nested family code before the wrapper's own shape", () => {
    const wrappedSync = Object.assign(new Error(`cycle wrapper ${SENTINEL}`), {
      cause: new SyncError("generation_changed", `uidvalidity changed ${SENTINEL}`),
    });
    expect(classifyFailure(wrappedSync)).toBe("generation_changed");
    const wrappedIngestion = Object.assign(new Error(`ingest wrapper ${SENTINEL}`), {
      cause: new IngestionError("parse_failed", SENTINEL),
    });
    expect(classifyFailure(wrappedIngestion)).toBe("ingestion_parse_failed");
  });

  it("reports the outermost error family when nothing stronger exists", () => {
    expect(classifyFailure(new TypeError(`fetch failed ${SENTINEL}`))).toBe("error_typeerror");
    const abort = new Error(`The operation was aborted ${SENTINEL}`);
    abort.name = "AbortError";
    expect(classifyFailure(abort)).toBe("error_aborterror");
  });

  it.each([
    ["a plain string throw", `thread pass ${SENTINEL} threw a string`],
    ["a plain Error", new Error(`body fetch failed for ${SENTINEL}`)],
    ["an object throw", { private: SENTINEL }],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
  ])("answers unknown for %s", (_label, cause) => {
    expect(classifyFailure(cause)).toBe(UNKNOWN_FAILURE_KIND);
  });

  it.each([
    ["SQL text", `DROP TABLE messages; -- ${SENTINEL}`],
    ["text with spaces", `not enough space for ${SENTINEL}`],
    ["a lowercase errno", `econnrefused ${SENTINEL}`],
  ])("drops a code shaped like %s instead of trusting it", (_label, code) => {
    const fault = Object.assign(new Error(SENTINEL), { code });
    expect(classifyFailure(fault)).toBe(UNKNOWN_FAILURE_KIND);
  });

  it("drops an error name that is not a constructor name", () => {
    const fault = new Error(SENTINEL);
    fault.name = `Not A Name ${SENTINEL}`;
    expect(classifyFailure(fault)).toBe(UNKNOWN_FAILURE_KIND);
  });

  it("stops searching nested causes at a bounded depth", () => {
    let deep = utf8Fault();
    for (let level = 0; level < 10; level += 1) {
      deep = Object.assign(new Error(`wrapper ${level} ${SENTINEL}`), { cause: deep });
    }
    expect(classifyFailure(deep)).not.toBe("database_22021");
  });

  it("survives a self-referential cause chain", () => {
    const loop: Error & { cause?: unknown } = Object.assign(new Error(`loop ${SENTINEL}`), {});
    loop.cause = loop;
    expect(classifyFailure(loop)).toBe(UNKNOWN_FAILURE_KIND);
  });

  it("answers a kind that fits the approved shape for every input above", () => {
    const inputs: unknown[] = [
      new SyncError("not_found", SENTINEL),
      wrappedFault(),
      utf8Fault(),
      "a string",
      { object: true },
      null,
    ];
    for (const input of inputs) {
      expect(classifyFailure(input)).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
    }
  });
});
