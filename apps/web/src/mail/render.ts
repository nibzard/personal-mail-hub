/*
 * The rendering transform between the sanitized body derivative and the
 * sandboxed reader frame (SPEC F3 and section 9). The server sanitizer
 * already removed active content; this pass adds the reader's own rules:
 * remote images stay blocked until the reader loads them, `cid:` references
 * resolve only against verified inline images of the same message, quoted
 * replies collapse behind one toggle, and links open as new tabs without
 * window control.
 *
 * The function is pure: the same inputs always produce the same document, so
 * "Load images" simply reruns it with remote loading on.
 */

/** Theme values the rendered document needs; read from the live CSS roles. */
export interface ReaderColors {
  background: string;
  foreground: string;
  mutedForeground: string;
  accent: string;
  border: string;
  /** The interface font stack, reused for reading text. */
  font: string;
}

/** One prepared message and what the reader should tell about it. */
export interface PreparedMessage {
  /** A complete HTML document for the frame's `srcdoc`. */
  document: string;
  /** Remote images the sender referenced. They stay blocked until loaded. */
  remoteImageCount: number;
}

/** The label of one collapsed quoted reply chain. */
const TRIMMED_LABEL = "Show trimmed content";

/** The note a blocked remote image leaves in its place. */
const REMOTE_BLOCKED_LABEL = "Remote image not loaded";

/** The note an unresolved inline reference leaves in its place. */
const INLINE_MISSING_LABEL = "Inline image not shown";

export function prepareMessageDocument(input: {
  html: string;
  inlineImages: ReadonlyMap<string, string> | null;
  allowRemoteImages: boolean;
  colors: ReaderColors;
}): PreparedMessage {
  const parsed = new DOMParser().parseFromString(input.html, "text/html");
  const remoteImageCount = transformImages(parsed, input.inlineImages, input.allowRemoteImages);
  collapseQuotes(parsed);
  hardenAnchors(parsed);
  return {
    document: buildDocument(parsed, input.colors, input.allowRemoteImages),
    remoteImageCount,
  };
}

/**
 * Applies the image policy and returns how many remote images are blocked.
 * A `cid:` reference resolves only through the verified map; anything else
 * the sender pointed elsewhere becomes a labeled placeholder.
 */
function transformImages(
  document: Document,
  inlineImages: ReadonlyMap<string, string> | null,
  allowRemoteImages: boolean,
): number {
  let remoteImageCount = 0;
  for (const image of [...document.querySelectorAll("img")]) {
    const source = image.getAttribute("src")?.trim() ?? "";
    const alt = image.getAttribute("alt")?.trim() ?? "";

    if (source.toLowerCase().startsWith("cid:")) {
      const contentId = source.slice(4).trim();
      const resolved = inlineImages?.get(contentId);
      if (resolved !== undefined) {
        image.setAttribute("src", resolved);
        continue;
      }
      replaceWithPlaceholder(image, INLINE_MISSING_LABEL, alt);
      continue;
    }

    if (isRemoteSource(source)) {
      remoteImageCount += 1;
      if (allowRemoteImages) {
        image.setAttribute("referrerpolicy", "no-referrer");
        continue;
      }
      replaceWithPlaceholder(image, REMOTE_BLOCKED_LABEL, alt);
      continue;
    }

    // Anything left, including a missing source, never loads.
    replaceWithPlaceholder(image, INLINE_MISSING_LABEL, alt);
  }
  return remoteImageCount;
}

/** `http`, `https`, and protocol-relative references all count as remote. */
function isRemoteSource(source: string): boolean {
  return /^(?:https?:)?\/\//i.test(source);
}

/** Puts one labeled box where the sender placed an image we do not load. */
function replaceWithPlaceholder(image: Element, label: string, alt: string): void {
  const placeholder = image.ownerDocument!.createElement("span");
  placeholder.className = "mail-image-note";
  placeholder.textContent = alt.length > 0 ? `${label}: ${alt}` : label;
  image.replaceWith(placeholder);
}

/**
 * Wraps every outermost quoted block in a closed toggle (SPEC F3). Nested
 * quotes stay inside their outer toggle, so one control collapses the chain.
 */
function collapseQuotes(document: Document): void {
  const quotes = [...document.querySelectorAll("blockquote")];
  for (const quote of quotes) {
    // An outer quote may already have become a toggle, so the walk treats
    // both blockquotes and our own wrappers as quote ancestors.
    let ancestor = quote.parentElement;
    while (ancestor !== null) {
      if (
        ancestor.tagName === "BLOCKQUOTE" ||
        (ancestor.tagName === "DETAILS" && ancestor.classList.contains("mail-quote"))
      ) {
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (ancestor !== null) {
      continue;
    }

    const details = document.createElement("details");
    details.className = "mail-quote";
    const summary = document.createElement("summary");
    summary.textContent = TRIMMED_LABEL;
    const content = document.createElement("div");
    content.className = "mail-quote-body";
    while (quote.firstChild !== null) {
      content.append(quote.firstChild);
    }
    details.append(summary, content);
    quote.replaceWith(details);
  }
}

/** Every link opens a fresh tab that cannot reach back into the reader. */
function hardenAnchors(document: Document): void {
  for (const anchor of document.querySelectorAll("a")) {
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
    anchor.setAttribute("referrerpolicy", "no-referrer");
  }
}

/** Wraps the transformed fragment in its own policy and reading styles. */
function buildDocument(fragment: Document, colors: ReaderColors, allowRemoteImages: boolean): string {
  const policy = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    // Inline images arrive as data URLs; remote images load only on request.
    `img-src data:${allowRemoteImages ? " https:" : ""}`,
  ].join("; ");

  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    `<style>${readingStyles(colors)}</style>`,
    "</head><body>",
    fragment.body?.innerHTML ?? "",
    "</body></html>",
  ].join("");
}

/** Reading styles for one message; sender inline colors still apply. */
function readingStyles(colors: ReaderColors): string {
  return `
:root { color-scheme: light dark; }
html { background: ${colors.background}; }
body {
  margin: 0;
  padding: 0.75rem 0.75rem 1.5rem;
  color: ${colors.foreground};
  font-family: ${colors.font};
  font-size: 1rem;
  line-height: 1.625;
  overflow-wrap: anywhere;
}
img { max-width: 100%; height: auto; }
a { color: ${colors.accent}; }
table { max-width: 100%; border-collapse: collapse; }
pre { overflow-x: auto; }
.mail-image-note {
  display: block;
  box-sizing: border-box;
  max-width: 100%;
  margin: 0.5rem 0;
  padding: 0.5rem 0.75rem;
  border: 1px dashed ${colors.border};
  border-radius: 0.5rem;
  color: ${colors.mutedForeground};
  font-size: 0.875rem;
}
.mail-quote {
  margin: 0.5rem 0;
  border: 1px solid ${colors.border};
  border-radius: 0.5rem;
}
.mail-quote > summary {
  cursor: pointer;
  padding: 0.375rem 0.75rem;
  color: ${colors.mutedForeground};
  font-size: 0.875rem;
}
.mail-quote-body {
  padding: 0.25rem 0.75rem 0.625rem;
  margin: 0;
  border-inline-start: 3px solid ${colors.border};
  color: ${colors.mutedForeground};
}
blockquote {
  margin: 0.25rem 0;
  padding: 0.125rem 0 0.125rem 0.75rem;
  border-inline-start: 3px solid ${colors.border};
}
`.trim();
}
