import MarkdownIt from "markdown-it";
import { HtmlSanitizer } from "@mail-hub/ingestion";

/**
 * Markdown rendering for outbound mail (SPEC F6).
 *
 * Markdown is the source of truth; the HTML alternative is a derived render:
 * `markdown-it` with raw HTML disabled, then the same server-side DOMPurify
 * pass the reader uses. Raw HTML in the source is escaped, never passed
 * through, and the result is wrapped in a minimal template with inline CSS
 * only, because email clients strip stylesheets.
 */

/** One renderer instance, configured once. */
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

/**
 * Render one Markdown source into the sanitized HTML alternative of an
 * outbound message. Empty Markdown renders an empty document, so a send with
 * no body text still produces both alternatives.
 */
export function renderMarkdownHtml(source: string, sanitizer = new HtmlSanitizer()): string {
  const rendered = markdown.render(source);
  return wrapInTemplate(sanitizer.sanitizeHtml(rendered));
}

/**
 * The minimal inline-CSS template around one rendered body (SPEC F6). One
 * system sans-serif stack, reading-size text, and a measure near 70
 * characters; no classes and no stylesheets survive an email client anyway.
 */
function wrapInTemplate(body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<body>",
    '<div style="font-family:-apple-system,BlinkMacSystemFont,&#x27;Segoe UI&#x27;,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1f2328;max-width:70ch;margin:0 auto;padding:12px 0;">',
    body,
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}
