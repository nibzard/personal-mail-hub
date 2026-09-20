// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { prepareMessageDocument, type ReaderColors } from "../src/mail/render.ts";

/*
 * The reader's rendering transform (SPEC F3): inline resolution, remote-image
 * blocking, quote collapsing, and link hardening. Inputs mirror what the
 * server sanitizer emits; the assertions pin what the sandboxed frame gets.
 */

const COLORS: ReaderColors = {
  background: "oklch(1 0 0)",
  foreground: "oklch(0.2 0 0)",
  mutedForeground: "oklch(0.5 0 0)",
  accent: "oklch(0.5 0.15 262)",
  border: "oklch(0.9 0 0)",
  font: "sans-serif",
};

function prepare(
  html: string,
  options: Partial<Parameters<typeof prepareMessageDocument>[0]> = {},
) {
  return prepareMessageDocument({
    html,
    inlineImages: null,
    allowRemoteImages: false,
    colors: COLORS,
    ...options,
  });
}

/** Parses the prepared body out of the complete frame document. */
function bodyOf(document: string): string {
  const start = document.indexOf("<body>") + "<body>".length;
  const end = document.lastIndexOf("</body>");
  return document.slice(start, end);
}

describe("prepareMessageDocument", () => {
  it("resolves a cid reference only through the verified inline images", () => {
    const prepared = prepare(
      '<p><img src="cid:chart@reports" alt="Chart"></p><p><img src="cid:twin@x" alt="Twin"></p>',
      { inlineImages: new Map([["chart@reports", "data:image/png;base64,QUJD"]]) },
    );

    const body = bodyOf(prepared.document);
    expect(body).toContain('src="data:image/png;base64,QUJD"');
    expect(body).toContain('alt="Chart"');
    // An ambiguous identifier stays a labeled download item, never a guess.
    expect(body).toContain("mail-image-note");
    expect(body).toContain("Inline image not shown: Twin");
    expect(prepared.remoteImageCount).toBe(0);
  });

  it("resolves a cid reference that arrives with angle brackets", () => {
    const prepared = prepare('<p><img src="cid:<chart@reports>" alt="Chart"></p>', {
      inlineImages: new Map([["chart@reports", "data:image/png;base64,QUJD"]]),
    });

    // The reference and the Content-ID header may disagree about the angle
    // brackets; both normalize, so the part resolves either way.
    expect(bodyOf(prepared.document)).toContain('src="data:image/png;base64,QUJD"');
  });

  it("keeps a plain-http image a labeled placeholder even after Load images", () => {
    const html = '<p><img src="http://tracker.example/pixel.gif" alt="Pixel"></p>';
    const loaded = prepare(html, { allowRemoteImages: true });
    const loadedBody = bodyOf(loaded.document);
    // The frame policy allows https images only, so this one can never load;
    // it says so instead of vanishing, and it never advertises the button.
    expect(loadedBody).not.toContain("tracker.example");
    expect(loadedBody).toContain("Insecure image not loaded: Pixel");
    expect(loaded.remoteImageCount).toBe(0);

    const blocked = prepare(html);
    expect(bodyOf(blocked.document)).toContain("Insecure image not loaded: Pixel");
    expect(blocked.remoteImageCount).toBe(0);
  });

  it("blocks remote images until the reader loads them", () => {
    const blocked = prepare(
      '<p><img src="https://tracker.example/pixel.gif" alt="Pixel"></p>',
    );
    expect(blocked.remoteImageCount).toBe(1);
    const blockedBody = bodyOf(blocked.document);
    expect(blockedBody).not.toContain("tracker.example");
    expect(blockedBody).toContain("Remote image not loaded: Pixel");
    expect(blocked.document).toContain("img-src data:");

    const loaded = prepare(
      '<p><img src="https://tracker.example/pixel.gif" alt="Pixel"></p>',
      { allowRemoteImages: true },
    );
    expect(loaded.remoteImageCount).toBe(1);
    expect(bodyOf(loaded.document)).toContain('src="https://tracker.example/pixel.gif"');
    expect(loaded.document).toContain("img-src data: https:");
  });

  it("collapses an outermost quote chain behind one toggle", () => {
    const prepared = prepare(
      "<p>Reply text</p><blockquote><p>Alice wrote</p><blockquote><p>older</p></blockquote></blockquote>",
    );

    const body = bodyOf(prepared.document);
    // The nested quote stays an ordinary blockquote inside the one toggle.
    expect(body).toContain("<blockquote");
    const toggles = body.match(/<summary[^>]*>/g) ?? [];
    expect(toggles).toHaveLength(1);
    expect(body).toContain("Show trimmed content");
    expect(body).toContain("mail-quote-body");
    // Both quote levels sit under the single toggle.
    const toggleStart = body.indexOf("<details");
    const quoteText = body.indexOf("older");
    expect(toggleStart).toBeGreaterThan(-1);
    expect(quoteText).toBeGreaterThan(toggleStart);
  });

  it("hardens every link", () => {
    const prepared = prepare('<p><a href="https://example.com/page">Link</a></p>');

    const body = bodyOf(prepared.document);
    expect(body).toContain('target="_blank"');
    expect(body).toContain('rel="noopener noreferrer"');
    expect(body).toContain('referrerpolicy="no-referrer"');
  });

  it("keeps the frame's own policy strict", () => {
    const prepared = prepare("<p>Hello</p>");

    expect(prepared.document).toContain("default-src 'none'");
    expect(prepared.document).toContain("style-src 'unsafe-inline'");
    // The theme values ride along as literal styles.
    expect(prepared.document).toContain("oklch(0.5 0.15 262)");
  });
});
