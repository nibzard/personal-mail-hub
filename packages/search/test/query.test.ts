import { describe, expect, it } from "vitest";
import { SearchError } from "../src/errors.ts";
import {
  JEV_CLASSES,
  isQueryEmpty,
  normalizeDomainValue,
  parseDateBoundary,
  parseSearchQuery,
} from "../src/query.ts";

/** Query parsing (SPEC F5): one operator grammar, one normalization. */

describe("parseSearchQuery", () => {
  it("splits free text from operators", () => {
    const parsed = parseSearchQuery("quarterly report from:alice is:unread");
    expect(parsed.text).toBe("quarterly report");
    expect(parsed.from).toEqual(["alice"]);
    expect(parsed.unread).toBe(true);
  });

  it("normalizes free text like ingestion does", () => {
    const parsed = parseSearchQuery("  QUARTERLY   Report  ");
    expect(parsed.text).toBe("quarterly report");
  });

  it("collects repeated sender, recipient, and domain values once", () => {
    const parsed = parseSearchQuery("from:alice from:alice to:bob domain:example.com to:bob");
    expect(parsed.from).toEqual(["alice"]);
    expect(parsed.to).toEqual(["bob"]);
    expect(parsed.domains).toEqual(["example.com"]);
  });

  it("keeps a quoted span as one phrase, colons included", () => {
    const parsed = parseSearchQuery('"https://example.com/x" "exact phrase"');
    expect(parsed.text).toBe('"https://example.com/x" "exact phrase"');
  });

  it("reads a quoted operator value with spaces", () => {
    const parsed = parseSearchQuery('from:"Alice Example"');
    expect(parsed.from).toEqual(["alice example"]);
  });

  it("parses every flag and attachment operator", () => {
    const parsed = parseSearchQuery("is:unread is:flagged is:action has:attachment");
    expect(parsed.unread).toBe(true);
    expect(parsed.flagged).toBe(true);
    expect(parsed.action).toBe(true);
    expect(parsed.hasAttachment).toBe(true);
  });

  it("accepts operator names and flag values in any case", () => {
    const parsed = parseSearchQuery("FROM:Alice IS:UNREAD Has:ATTACHMENT");
    expect(parsed.from).toEqual(["alice"]);
    expect(parsed.unread).toBe(true);
    expect(parsed.hasAttachment).toBe(true);
  });

  it("validates type values against the Jev classes", () => {
    const parsed = parseSearchQuery("type:security_alert type:newsletter");
    expect(parsed.types).toEqual(["security_alert", "newsletter"]);
    expect(() => parseSearchQuery("type:banana")).toThrowError(SearchError);
    expect(() => parseSearchQuery("type:banana")).toThrowError(/Unknown type/u);
  });

  it("lists exactly the eight Jev classes", () => {
    expect(JEV_CLASSES).toEqual([
      "correspondence",
      "receipt",
      "newsletter",
      "notification",
      "marketing",
      "security_alert",
      "bounce",
      "other",
    ]);
  });

  it("parses exclusive UTC date boundaries", () => {
    const parsed = parseSearchQuery("before:2026-09-01 after:2026-08-01");
    expect(parsed.before?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(parsed.after?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("rejects dates that are not real calendar days", () => {
    expect(() => parseSearchQuery("before:2026-02-30")).toThrowError(SearchError);
    expect(() => parseSearchQuery("after:09/01/2026")).toThrowError(SearchError);
    expect(() => parseSearchQuery("before:2026-13-01")).toThrowError(SearchError);
  });

  it("rejects unknown operators and empty values", () => {
    expect(() => parseSearchQuery("foo:bar")).toThrowError(/Unknown operator "foo:"/u);
    expect(() => parseSearchQuery("is:read")).toThrowError(/Unknown operator "is:read"/u);
    expect(() => parseSearchQuery("has:money")).toThrowError(/Unknown operator "has:money"/u);
    expect(() => parseSearchQuery("from:")).toThrowError(/needs a value/u);
  });

  it("rejects malformed domains and keeps the empty query empty", () => {
    expect(() => parseSearchQuery("domain:not_a_domain")).toThrowError(SearchError);
    expect(normalizeDomainValue("Example.COM")).toBe("example.com");
    expect(() => normalizeDomainValue("-example.com")).toThrowError(SearchError);
    expect(isQueryEmpty(parseSearchQuery(""))).toBe(true);
    expect(isQueryEmpty(parseSearchQuery("is:unread"))).toBe(false);
  });

  it("lets the last of repeated date boundaries win", () => {
    const parsed = parseSearchQuery("before:2026-01-01 before:2026-06-01");
    expect(parseDateBoundary("2026-06-01").getTime()).toBe(parsed.before?.getTime());
  });
});
