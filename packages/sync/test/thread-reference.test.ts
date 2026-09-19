import { describe, expect, it } from "vitest";
import { extractMessageIds, resolveParentReference } from "../src/threads.ts";

/**
 * Pure identifier rules of thread reconciliation (SPEC F2 "Message identity
 * and threading"). The header parse and the full parse store identifiers with
 * their angle brackets; extraction works on exactly that text.
 */
describe("extractMessageIds", () => {
  it("extracts one bracketed identifier", () => {
    expect(extractMessageIds("<one@example.com>")).toEqual(["<one@example.com>"]);
  });

  it("extracts several identifiers in order and drops repeats", () => {
    expect(extractMessageIds("<a@example.com> <b@example.com> <a@example.com>")).toEqual([
      "<a@example.com>",
      "<b@example.com>",
    ]);
  });

  it("finds the identifier a parser folded a comment into", () => {
    // mailparser rewrites `In-Reply-To: (note) <a@example.com>` this way.
    expect(extractMessageIds("<(note) <a@example.com>")).toEqual(["<a@example.com>"]);
  });

  it("keeps identifiers a strict grammar would reject", () => {
    // mailparser also wraps a bare value this way; holder and child compare
    // the same stored text, so the pair still links.
    expect(extractMessageIds("<not-an-id>")).toEqual(["<not-an-id>"]);
  });

  it("returns nothing for unbracketed or empty values", () => {
    expect(extractMessageIds("not an id")).toEqual([]);
    expect(extractMessageIds("")).toEqual([]);
    expect(extractMessageIds(null)).toEqual([]);
  });
});

describe("resolveParentReference", () => {
  it("uses the single In-Reply-To identifier", () => {
    expect(resolveParentReference("<parent@example.com>", ["<root@example.com>"])).toEqual({
      state: "candidate",
      identifier: "<parent@example.com>",
    });
  });

  it("falls back to the last valid References identifier", () => {
    expect(resolveParentReference(null, ["<root@example.com>", "<parent@example.com>"])).toEqual({
      state: "candidate",
      identifier: "<parent@example.com>",
    });
    expect(resolveParentReference("junk", ["<root@example.com>", "<parent@example.com>"])).toEqual({
      state: "candidate",
      identifier: "<parent@example.com>",
    });
  });

  it("treats several In-Reply-To identifiers as conflicted", () => {
    expect(resolveParentReference("<a@example.com> <b@example.com>", [])).toEqual({ state: "conflicted" });
  });

  it("resolves a root when no valid identifier exists anywhere", () => {
    expect(resolveParentReference(null, [])).toEqual({ state: "root" });
    expect(resolveParentReference("junk", ["also junk", ""])).toEqual({ state: "root" });
  });
});
