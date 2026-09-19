import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";

/**
 * Server-side HTML sanitizing for message bodies (SPEC section 9). The
 * sanitized string is a derived rendering; the durable original keeps the
 * exact bytes, including raw HTML, and is never rendered directly.
 *
 * DOMPurify removes active content here. The reader adds the second layer: a
 * sandboxed iframe with a restrictive content security policy. Remote-image
 * blocking stays a reader concern; `cid:` references survive so inline images
 * can resolve inside one message.
 */

/**
 * Identifies the exact sanitizer behavior that produced `bodies.html_sanitized`.
 * Change the configuration, then bump this version so stale derivatives are
 * detectable.
 */
export const SANITIZER_VERSION = "dompurify@3.4.15/config-1";

/** Tags with no safe role in a mail reader; sender colors live in inline `style` attributes. */
const FORBID_TAGS = [
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "template",
  "link",
  "meta",
  "base",
];

/** Pinned URI policy: web, mail, phone, and content-id references. */
const ALLOWED_URI_REGEXP = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i;

/** Sanitizes untrusted HTML fragments and extracts plain text from the result. */
export class HtmlSanitizer {
  private readonly purify: ReturnType<typeof DOMPurify>;

  constructor() {
    this.purify = DOMPurify(new JSDOM("").window);
  }

  /** Remove active content and unsafe URIs from one HTML fragment. */
  sanitizeHtml(html: string): string {
    return this.purify.sanitize(html, {
      FORBID_TAGS,
      FORBID_ATTR: ["srcdoc"],
      ALLOWED_URI_REGEXP,
    });
  }

  /** Readable text from already-sanitized HTML, with whitespace collapsed. */
  htmlToText(sanitizedHtml: string): string {
    const document = new JSDOM(sanitizedHtml).window.document;
    return (document.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  }
}
