import { describe, expect, it } from "vitest";
import { HtmlSanitizer, SANITIZER_VERSION } from "../src/sanitize.ts";

describe("HtmlSanitizer", () => {
  const sanitizer = new HtmlSanitizer();

  it("pins its version so stale derivatives stay detectable", () => {
    expect(SANITIZER_VERSION).toMatch(/^dompurify@\d+\.\d+\.\d+\/config-\d+$/);
  });

  it("removes active content", () => {
    const clean = sanitizer.sanitizeHtml(
      [
        '<p onclick="steal()">Text</p>',
        "<script>alert(1)</script>",
        '<img src="javascript:alert(1)">',
        '<a href="jAvAsCrIpT:alert(1)">link</a>',
        '<iframe src="https://evil.example"></iframe>',
        '<object data="https://evil.example/x.swf"></object>',
        "<template><img src=x onerror=alert(1)></template>",
      ].join(""),
    );
    expect(clean).toContain("Text");
    expect(clean).not.toContain("script");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("javascript");
    expect(clean).not.toContain("iframe");
    expect(clean).not.toContain("object");
    expect(clean).not.toContain("template");
    expect(clean).not.toContain("onerror");
  });

  it("keeps content-id images, web links, and inline colors", () => {
    const clean = sanitizer.sanitizeHtml(
      '<p style="color:#b00">Hi <a href="https://example.com/page">link</a>' +
        ' <img src="cid:abc123@sender" alt="sig"></p>',
    );
    expect(clean).toContain('src="cid:abc123@sender"');
    expect(clean).toContain('href="https://example.com/page"');
    expect(clean).toContain("color:#b00");
  });

  it("drops interactive and stylesheet markup that has no safe reader role", () => {
    const clean = sanitizer.sanitizeHtml(
      [
        "<style>@import url(https://evil.example/x.css);</style>",
        '<form action="https://evil.example"><input name="token"><textarea></textarea></form>',
        '<button>click</button><select><option>a</option></select>',
        '<meta http-equiv="refresh" content="0;url=https://evil.example">',
        '<base href="https://evil.example/">',
      ].join(""),
    );
    for (const tag of ["style", "form", "input", "textarea", "button", "select", "meta", "base", "@import"]) {
      expect(clean).not.toContain(tag);
    }
  });

  it("extracts readable text with collapsed whitespace from sanitized HTML", () => {
    const clean = sanitizer.sanitizeHtml("<div><p>Hello   <b>there</b>.</p>\n<p>Second</p></div>");
    expect(sanitizer.htmlToText(clean)).toBe("Hello there. Second");
  });

  it("returns empty text for element-only markup", () => {
    expect(sanitizer.htmlToText(sanitizer.sanitizeHtml('<img src="cid:x@y" alt="pic">'))).toBe("");
  });
});
