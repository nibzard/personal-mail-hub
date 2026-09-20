import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The web gateway serves the built shell behind a Content-Security-Policy
 * whose script-src allows exactly one inline script: the theme bootstrap in
 * index.html, pinned by its sha256 hash
 * (deploy/nginx-web.conf.template). Vite copies that script into
 * dist/index.html verbatim, so hashing the source keeps the check honest.
 * Editing the bootstrap without re-pinning the hash would leave production
 * users with a blocked script and a theme flash on every load; this test
 * fails first.
 */

const template = readFileSync(
  new URL("../../../deploy/nginx-web.conf.template", import.meta.url),
  "utf8",
);
const shell = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/** The inline, non-module scripts the shell carries. */
const inlineScripts = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
  (match) => match[1],
);

function sha256(source: string): string {
  return `sha256-${createHash("sha256").update(source, "utf8").digest("base64")}`;
}

describe("gateway content security policy", () => {
  it("pins the hash of the one inline script the shell carries", () => {
    expect(inlineScripts).toHaveLength(1);
    const pinned = sha256(inlineScripts[0]!);

    const scriptSources = [...template.matchAll(/script-src ([^;"]+)/g)].map((match) => match[1]);
    expect(scriptSources.length).toBeGreaterThan(0);
    for (const directives of scriptSources) {
      expect(directives).toContain(pinned);
      expect(directives).not.toContain("'unsafe-inline'");
    }
  });
});

describe("gateway compression", () => {
  it("compresses the text types the build serves, above a size floor", () => {
    // Without gzip the hashed JS and CSS cross the wire uncompressed on a
    // cold visit. nginx always compresses text/html when gzip is on, so
    // listing it in gzip_types would only add a startup warning.
    expect(template).toContain("gzip on;");
    expect(template).toContain("gzip_vary on;");
    expect(template).toContain("gzip_min_length");

    const types = template.match(/^    gzip_types ([^;]+);/m)?.[1] ?? "";
    for (const mime of [
      "text/css",
      "text/javascript",
      "application/javascript",
      "application/json",
      "application/manifest+json",
      "image/svg+xml",
    ]) {
      expect(types).toContain(mime);
    }
    expect(types).not.toContain("text/html");
  });
});
