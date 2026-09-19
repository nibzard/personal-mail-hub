/*
 * Checks the semantic color tokens in src/styles.css against WCAG 2.2
 * contrast thresholds. Text pairs must reach 4.5:1; the focus ring must
 * reach 3:1 against the background. Run with `npm run check:tokens`.
 */

import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function parseBlock(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) {
    throw new Error(`Selector ${selector} was not found.`);
  }
  const end = css.indexOf("}", start);
  const body = css.slice(start, end);
  const tokens = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*oklch\(([^)]+)\)/g)) {
    const [l, c, h] = match[2].split("/")[0].trim().split(/\s+/).map(Number);
    tokens[match[1]] = { l, c, h };
  }
  return tokens;
}

function oklchToLinearRgb({ l, c, h }) {
  const angle = (h * Math.PI) / 180;
  const a = c * Math.cos(angle);
  const b = c * Math.sin(angle);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const li = l_ ** 3;
  const mi = m_ ** 3;
  const si = s_ ** 3;
  return [
    4.0767416621 * li - 3.3077115913 * mi + 0.2309699292 * si,
    -1.2684380046 * li + 2.6097574011 * mi - 0.3413193965 * si,
    -0.0041960863 * li - 0.7034186147 * mi + 1.707614701 * si,
  ];
}

function luminance(token) {
  const [r, g, b] = oklchToLinearRgb(token);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Text-on-surface pairs must reach 4.5:1. The ring is a non-text boundary
// and must reach 3:1 against the background.
const textPairs = [
  ["foreground", "background"],
  ["surface-foreground", "surface"],
  ["surface-raised-foreground", "surface-raised"],
  ["muted-foreground", "background"],
  ["muted-foreground", "surface"],
  ["accent-foreground", "accent"],
  ["accent-muted-foreground", "accent-muted"],
  ["destructive-foreground", "destructive"],
  ["destructive-muted-foreground", "destructive-muted"],
  ["success-foreground", "success"],
  ["success-muted-foreground", "success-muted"],
  ["warning-foreground", "warning"],
  ["warning-muted-foreground", "warning-muted"],
  ["info-foreground", "info"],
  ["info-muted-foreground", "info-muted"],
];

const failures = [];

for (const theme of ["light", "dark"]) {
  const tokens = parseBlock(theme === "light" ? ":root" : ".dark");
  for (const [fg, bg] of textPairs) {
    if (tokens[fg] === undefined || tokens[bg] === undefined) {
      failures.push(`${theme}: missing --${fg} or --${bg}`);
      continue;
    }
    const ratio = contrast(tokens[fg], tokens[bg]);
    if (ratio < 4.5) {
      failures.push(
        `${theme}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1, below 4.5:1`,
      );
    }
  }
  const ringRatio = contrast(tokens.ring, tokens.background);
  if (ringRatio < 3) {
    failures.push(
      `${theme}: --ring on --background is ${ringRatio.toFixed(2)}:1, below 3:1`,
    );
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Token contrast checks passed for light and dark themes.");
