import { createRequire } from "node:module";
import { expect, type Locator, type Page } from "@playwright/test";

/*
 * Shared helpers for the browser checks: loading the shell against the
 * fixture API, reading the keyboard selection, and running axe against a
 * loaded page.
 */

/** Resolved path of the bundled axe-core script, injected per page. */
const axeSourcePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/** The subset of axe results the checks report. */
export interface AxeViolation {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  help: string;
  helpUrl: string;
  nodes: Array<{ target: Array<string | number> }>;
}

/** Impact levels the WCAG 2.2 AA checks treat as failures. */
const FAILING_IMPACTS = new Set(["moderate", "serious", "critical"]);

/**
 * Opens the shell and waits for the first page of the unified inbox. The
 * list arrives after the session probe and the folder index, so the first
 * visible row means the initial requests all settled.
 */
export async function openInbox(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#message-list [data-message-row]").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Mail" })).toBeVisible();
}

/** The message id the keyboard selection marks, or `null` when none. */
export async function selectedRowId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const selected = document.querySelector("#message-list [aria-current='true']");
    return selected === null ? null : selected.getAttribute("data-message-row");
  });
}

/** The polite status line that announces the keyboard selection. */
export function selectionAnnouncement(page: Page): Locator {
  return page.locator("p[role='status']").filter({ hasText: /^Selected: /u });
}

/**
 * Runs axe against the page and returns the violations whose impact the
 * checks fail on. The sandboxed reader frame is excluded: it is a separate
 * document without same-origin rights, and its transform has its own unit
 * coverage in `test/render.test.ts`.
 */
export async function axeViolations(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: axeSourcePath });
  const violations = await page.evaluate(async (): Promise<AxeViolation[]> => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            context: unknown,
            options: unknown,
          ) => Promise<{ violations: AxeViolation[] }>;
      };
    }
    ).axe;
    const results = await axe.run({ exclude: [["#message-body-frame"]] }, { iframes: false });
    return results.violations;
  });
  return violations.filter((violation) => FAILING_IMPACTS.has(violation.impact ?? ""));
}

/** One line per violation, for failure output a person can act on. */
export function describeViolations(violations: AxeViolation[]): string {
  return violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? "no impact"}): ${violation.help} ` +
        `[${violation.nodes.map((node) => node.target.join(" ")).join(", ")}] ` +
        `${violation.helpUrl}`,
    )
    .join("\n");
}

declare global {
  interface Window {
    /** Set by the palette latency probe in `flows.browser.ts`. */
    __paletteTiming: { keydown: number; focus: number | null } | null;
  }
}
