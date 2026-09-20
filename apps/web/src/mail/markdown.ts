import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import type { ReaderColors } from "./render";

/*
 * The compose preview pipeline (SPEC F6). Markdown is the source of truth;
 * the preview derives from it and never writes back. Rendering goes through
 * a pinned `markdown-it` with raw HTML disabled, so markup in the source is
 * escaped text, then through DOMPurify, then through the same remote-image
 * policy the reader applies: remote images stay blocked with a labeled
 * placeholder until they are allowed on request.
 */

/** The pinned renderer. `html: false` escapes raw HTML in the source. */
const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});

/** What one prepared preview carries. */
export interface ComposedPreview {
  /** The sanitized HTML fragment, remote images already resolved. */
  html: string;
  /** Remote images the source referenced and the preview blocked. */
  remoteImageCount: number;
}

/** The note a blocked remote image leaves in its place. */
const REMOTE_BLOCKED_LABEL = "Remote image not loaded";

/**
 * The note a plain-`http:` image leaves in its place. The frame policy
 * allows `https:` images only, so this one can never load, whatever the
 * preview decided about remote images.
 */
const INSECURE_IMAGE_LABEL = "Insecure image not loaded";

/**
 * Renders one Markdown source into a sanitized preview fragment. The same
 * source always produces the same document, so "Load images" simply reruns
 * this with remote loading on.
 */
export function renderMarkdownPreview(source: string): ComposedPreview {
  return preparePreviewDocument(source, { allowRemoteImages: false });
}

/**
 * Renders one Markdown source for the preview pane, remote images included
 * only when asked (SPEC F6: the remote-image policy covers the preview).
 */
export function preparePreviewDocument(
  source: string,
  options: { allowRemoteImages: boolean },
): ComposedPreview {
  const rendered = markdown.render(source);
  const sanitized = DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "iframe", "script"],
    FORBID_ATTR: ["style"],
  });
  const parsed = new DOMParser().parseFromString(sanitized, "text/html");
  const remoteImageCount = applyImagePolicy(parsed, options.allowRemoteImages);
  hardenAnchors(parsed);
  return { html: parsed.body?.innerHTML ?? "", remoteImageCount };
}

/**
 * Applies the image policy and returns how many remote images are blocked.
 * Only `data:` sources load without permission; anything remote becomes a
 * labeled placeholder until loading is allowed.
 */
function applyImagePolicy(document: Document, allowRemoteImages: boolean): number {
  let remoteImageCount = 0;
  for (const image of [...document.querySelectorAll("img")]) {
    const source = image.getAttribute("src")?.trim() ?? "";
    const alt = image.getAttribute("alt")?.trim() ?? "";
    if (source.toLowerCase().startsWith("data:")) {
      continue;
    }
    if (isRemoteSource(source)) {
      if (isInsecureSource(source)) {
        // The frame policy allows `https:` images only, so a plain-http
        // link can never load and says so instead of vanishing.
        replaceWithPlaceholder(image, alt, INSECURE_IMAGE_LABEL);
        continue;
      }
      remoteImageCount += 1;
      if (allowRemoteImages) {
        image.setAttribute("referrerpolicy", "no-referrer");
        continue;
      }
    }
    replaceWithPlaceholder(image, alt);
  }
  return remoteImageCount;
}

/** `http`, `https`, and protocol-relative references all count as remote. */
function isRemoteSource(source: string): boolean {
  return /^(?:https?:)?\/\//i.test(source);
}

/** `http:` references; the frame's image policy allows `https:` only. */
function isInsecureSource(source: string): boolean {
  return /^http:\/\//i.test(source);
}

/** Puts one labeled box where the source placed an image we do not load. */
function replaceWithPlaceholder(image: Element, alt: string, label = REMOTE_BLOCKED_LABEL): void {
  const placeholder = image.ownerDocument!.createElement("span");
  placeholder.className = "mail-image-note";
  placeholder.textContent = alt.length > 0 ? `${label}: ${alt}` : label;
  image.replaceWith(placeholder);
}

/** Every link opens a fresh tab that cannot reach back into the app. */
function hardenAnchors(document: Document): void {
  for (const anchor of document.querySelectorAll("a")) {
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
    anchor.setAttribute("referrerpolicy", "no-referrer");
  }
}

/** Wraps one preview fragment in the sandbox document the pane shows. */
export function buildPreviewDocument(
  fragment: string,
  colors: ReaderColors,
  allowRemoteImages: boolean,
): string {
  const policy = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data:${allowRemoteImages ? " https:" : ""}`,
  ].join("; ");

  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    `<style>${previewStyles(colors)}</style>`,
    "</head><body>",
    fragment,
    "</body></html>",
  ].join("");
}

/** Reading styles for one preview; the app theme supplies the roles. */
function previewStyles(colors: ReaderColors): string {
  return `
:root { color-scheme: light dark; }
html { background: ${colors.background}; }
body {
  margin: 0;
  padding: 0.75rem;
  color: ${colors.foreground};
  font-family: ${colors.font};
  font-size: 1rem;
  line-height: 1.625;
  overflow-wrap: anywhere;
}
img { max-width: 100%; height: auto; }
a { color: ${colors.accent}; }
pre { overflow-x: auto; }
code { font-size: 0.875em; }
pre code { display: block; padding: 0.5rem 0.75rem; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1rem 0 0.375rem; }
h1 { font-size: 1.375rem; }
h2 { font-size: 1.1875rem; }
h3 { font-size: 1.0625rem; }
p { margin: 0.375rem 0; }
ul, ol { margin: 0.375rem 0; padding-inline-start: 1.375rem; }
blockquote {
  margin: 0.5rem 0;
  padding: 0.125rem 0 0.125rem 0.75rem;
  border-inline-start: 3px solid ${colors.border};
  color: ${colors.mutedForeground};
}
table { max-width: 100%; border-collapse: collapse; }
th, td { border: 1px solid ${colors.border}; padding: 0.25rem 0.5rem; }
hr { border: 0; border-top: 1px solid ${colors.border}; }
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
`.trim();
}
