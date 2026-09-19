import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentExtractor, EXTRACTION_VERSION } from "../src/index.ts";
import { CORPUS, corpusEntry } from "./fixtures.ts";

/*
 * The extraction corpus suite (SPEC section 12, "Defuddle corpus").
 * Snapshot tests pin the Markdown and clean-view output so a pinned-version
 * upgrade is deliberate: a changed snapshot is a review, not a surprise.
 */

/**
 * The version of the defuddle installation this suite loads. Resolved from
 * the package entry Node loads, so a hoisted or a nested install answers
 * alike.
 */
function installedDefuddleVersion(): string {
  const entry = createRequire(import.meta.url).resolve("defuddle");
  const marker = `${sep}node_modules${sep}`;
  const packageDir = `${entry.slice(0, entry.lastIndexOf(marker))}${marker}defuddle`;
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string") {
    throw new Error(`The defuddle manifest at ${packageDir} names no version.`);
  }
  return manifest.version;
}

beforeEach(() => {
  // Extraction and preview must not touch the network. Defuddle receives
  // `useAsync: false` and a refusing fetch; this guard fails the test if any
  // code path still reaches for the global client.
  vi.stubGlobal("fetch", () => {
    throw new Error("Extraction must not fetch.");
  });
});

describe("the pinned extraction version", () => {
  it("names the installed Defuddle version", () => {
    const version = /^defuddle@(\d+\.\d+\.\d+)\/config-\d+$/.exec(EXTRACTION_VERSION)?.[1];
    // A dependency upgrade must move the constant with it; a mismatch here
    // means the reported extraction behavior is wrong, whatever the code runs.
    expect(version, EXTRACTION_VERSION).toBeDefined();
    expect(version).toBe(installedDefuddleVersion());
  });
});

describe("reply quote extraction", () => {
  it("pins the Markdown blockquote of every corpus entry", async () => {
    const extractor = new ContentExtractor();
    for (const entry of CORPUS) {
      const quote = await extractor.extractReplyQuote(entry);
      expect(quote, entry.name).toMatchSnapshot(`${entry.name} quote`);
    }
  });

  it("derives the quote from sanitized HTML when extraction succeeds", async () => {
    const quote = await new ContentExtractor().extractReplyQuote(corpusEntry("gmail-reply-chain"));
    expect(quote.source).toBe("extracted");
    expect(quote.markdown.startsWith("> Thanks for the quick review.")).toBe(true);
  });

  it("falls back to the plain-text part of a text-only message", async () => {
    const quote = await new ContentExtractor().extractReplyQuote(corpusEntry("text-only"));
    expect(quote.source).toBe("plain_text");
    expect(quote.markdown).toBe(
      "> The backup window moved to 02:00 UTC on Sunday. Nothing for you to do; this is a heads-up for the runbook.",
    );
  });

  it("falls back to plain text when the HTML part holds nothing quotable", async () => {
    const quote = await new ContentExtractor().extractReplyQuote(corpusEntry("empty-html-with-text"));
    expect(quote.source).toBe("plain_text");
    expect(quote.markdown).toContain("Approved from the plain part.");
  });

  it("quotes even a one-line parent", async () => {
    const quote = await new ContentExtractor().extractReplyQuote(corpusEntry("short-note"));
    expect(quote.source).toBe("extracted");
    expect(quote.markdown).toBe("> Lunch at noon?");
  });

  it("reads the text out of sanitized HTML when extraction fails without a plain part", async () => {
    const extractor = new (class extends ContentExtractor {
      protected override runDefuddle(): Promise<never> {
        return Promise.reject(new Error("extraction exploded"));
      }
    })();
    const quote = await extractor.extractReplyQuote({
      htmlSanitized: "<div><p>Only one body part here.</p></div>",
      textPlain: null,
    });
    expect(quote.source).toBe("html_text");
    expect(quote.markdown).toBe("> Only one body part here.");
  });

  it("returns an empty quote when the parent has no readable body", async () => {
    const quote = await new ContentExtractor().extractReplyQuote(corpusEntry("empty-body"));
    expect(quote).toEqual({ markdown: "", source: "none" });
  });

  it("never quotes literal HTML tags", async () => {
    const extractor = new ContentExtractor();
    for (const entry of CORPUS) {
      const quote = await extractor.extractReplyQuote(entry);
      // Escaped sequences render as text; only an unescaped tag-like
      // sequence would become raw HTML in the compose preview.
      expect(quote.markdown, entry.name).not.toMatch(
        /(?<!\\)<\/?[a-z][a-z0-9-]*(?:\s|\/?>)/i,
      );
    }
  });
});

describe("clean view extraction", () => {
  it("pins the clean view of every corpus entry with HTML", async () => {
    const extractor = new ContentExtractor();
    for (const entry of CORPUS) {
      if (entry.htmlSanitized === null) {
        continue;
      }
      const view = await extractor.extractCleanView(entry.htmlSanitized);
      expect(view.diagnostics, entry.name).toBeNull();
      expect(view.html, entry.name).toMatchSnapshot(`${entry.name} clean view`);
    }
  });

  it("falls back to the sanitized original when extraction is empty", async () => {
    const view = await new ContentExtractor().extractCleanView(corpusEntry("empty-body").htmlSanitized!);
    expect(view.source).toBe("original_fallback");
    expect(view.html).toBe(corpusEntry("empty-body").htmlSanitized);
  });

  it("falls back to the sanitized original when extraction throws", async () => {
    const html = "<div><p>Anything readable.</p></div>";
    const extractor = new (class extends ContentExtractor {
      protected override runDefuddle(): Promise<never> {
        return Promise.reject(new Error("extraction exploded"));
      }
    })();
    const view = await extractor.extractCleanView(html);
    expect(view).toEqual({ html, source: "original_fallback", diagnostics: null });
  });

  it("sanitizes the Defuddle output again", async () => {
    const hostile =
      '<div><p>Click this.</p><script>window.location="https://tracker.example/steal"</script>' +
      '<p onclick="steal()">Second line.</p><a href="javascript:steal()">link</a>' +
      '<img src="https://tracker.example/pixel" onerror="steal()"></div>';
    const view = await new ContentExtractor().extractCleanView(hostile);
    expect(view.html).not.toContain("<script");
    expect(view.html).not.toContain("onerror");
    expect(view.html).not.toContain("onclick");
    expect(view.html).not.toContain("javascript:");
  });

  it("keeps inline content references the reader resolves", async () => {
    const view = await new ContentExtractor().extractCleanView(
      '<div><p>See the diagram.</p><img src="cid:diagram@local" alt="diagram"></div>',
    );
    expect(view.source).toBe("extracted");
    expect(view.html).toContain("cid:diagram@local");
  });
});

describe("redacted diagnostics", () => {
  it("counts removals by step and reason without removed text", async () => {
    const view = await new ContentExtractor().extractCleanView(corpusEntry("newsletter").htmlSanitized!, {
      diagnostics: true,
    });
    expect(view.diagnostics).not.toBeNull();
    const recorded = JSON.stringify(view.diagnostics);
    // Removal counts and reasons are safe to log; removed message text and
    // raw HTML are not (SPEC F6, Defuddle rules).
    for (const removed of ["Unsubscribe", "Example Newsletter", "Preferences", "example.org/unsubscribe"]) {
      expect(recorded, removed).not.toContain(removed);
    }
    for (const tally of view.diagnostics!.removals) {
      expect(tally.count).toBeGreaterThan(0);
      expect(tally.step).toMatch(/^[a-z-]+$/i);
    }
  });

  it("stays absent without the diagnostics option", async () => {
    const view = await new ContentExtractor().extractCleanView(corpusEntry("gmail-reply-chain").htmlSanitized!);
    expect(view.diagnostics).toBeNull();
  });
});
