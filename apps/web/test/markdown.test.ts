// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  buildPreviewDocument,
  preparePreviewDocument,
  renderMarkdownPreview,
} from "../src/mail/markdown.ts";

/*
 * The compose preview pipeline (SPEC F6): Markdown renders through a pinned
 * renderer with raw HTML disabled, the result sanitizes, remote images stay
 * blocked behind a labeled placeholder until they are allowed on request,
 * and the sandbox document the pane shows derives its CSP from that policy.
 */

const COLORS = {
  background: "#ffffff",
  foreground: "#111111",
  accent: "#2563eb",
  border: "#dddddd",
  mutedForeground: "#666666",
  font: "system-ui",
};

describe("renderMarkdownPreview", () => {
  it("renders Markdown structure and escapes raw HTML, not its text", () => {
    const preview = renderMarkdownPreview("# Title\n\n<b>bold</b> *and emphasis*\n");
    expect(preview.html).toContain("<h1>Title</h1>");
    expect(preview.html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(preview.html).toContain("<em>and emphasis</em>");
    expect(preview.html).not.toContain("<b>bold</b>");
  });

  it("keeps script and style out of the fragment", () => {
    const preview = renderMarkdownPreview(
      "text\n\n<script>alert(1)</script>\n\n<style>body{display:none}</style>\n",
    );
    expect(preview.html).not.toContain("<script");
    expect(preview.html).not.toContain("<style");
    expect(preview.html).toContain("alert(1)");
  });
});

describe("preparePreviewDocument", () => {
  it("counts and replaces remote images while they are not allowed", () => {
    const preview = preparePreviewDocument(
      "![chart](https://tracker.example/pixel.gif)\n\n![inline](data:image/png;base64,AAAA)\n",
      { allowRemoteImages: false },
    );
    expect(preview.remoteImageCount).toBe(1);
    expect(preview.html).toContain("Remote image not loaded: chart");
    expect(preview.html).not.toContain("tracker.example");
    // The data: image loads without permission.
    expect(preview.html).toContain("data:image/png;base64,AAAA");
  });

  it("keeps remote images when they are allowed on request", () => {
    const preview = preparePreviewDocument("![chart](https://tracker.example/pixel.gif)", {
      allowRemoteImages: true,
    });
    expect(preview.remoteImageCount).toBe(1);
    expect(preview.html).toContain("tracker.example/pixel.gif");
    expect(preview.html).not.toContain("Remote image not loaded");
  });

  it("hardens every anchor against the app origin", () => {
    const preview = preparePreviewDocument("[notes](https://example.com/notes)", {
      allowRemoteImages: false,
    });
    expect(preview.html).toContain('target="_blank"');
    expect(preview.html).toContain('rel="noopener noreferrer"');
  });

  it("derives the same document for the same source", () => {
    const source = "# Same\n\nbody text\n";
    expect(renderMarkdownPreview(source)).toEqual(
      preparePreviewDocument(source, { allowRemoteImages: false }),
    );
  });
});

describe("buildPreviewDocument", () => {
  it("blocks remote images in the frame policy until they are allowed", () => {
    const fragment = preparePreviewDocument("x", { allowRemoteImages: false }).html;
    const blocked = buildPreviewDocument(fragment, COLORS, false);
    expect(blocked).toContain("img-src data:");
    expect(blocked).not.toContain("img-src data: https:");

    const allowed = buildPreviewDocument(fragment, COLORS, true);
    expect(allowed).toContain("img-src data: https:");
  });

  it("allows nothing beyond images and inline styles by default", () => {
    const document = buildPreviewDocument("<p>hi</p>", COLORS, false);
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("style-src 'unsafe-inline'");
    expect(document).toContain("<p>hi</p>");
  });
});
