import { expect, test, type Page } from "@playwright/test";
import { axeViolations, describeViolations, openInbox } from "./helpers";

/*
 * Interface checks (SPEC F12 and section 12, "Interface acceptance"):
 * axe scans in both palettes, screen-reader semantics, visible keyboard
 * focus, reduced motion, reflow at 320 px and 200% text zoom, touch
 * targets, pane layouts, and theme switching. Runs against the production
 * build over the fixture API.
 */

/** Fails the test when axe reports a WCAG-relevant violation. */
async function expectNoAxeViolations(page: Page): Promise<void> {
  const violations = await axeViolations(page);
  expect(
    violations,
    `axe reported violations:\n${describeViolations(violations)}`,
  ).toEqual([]);
}

test.describe("axe", () => {
  test("the light shell, reader, and palette pass", async ({ page }) => {
    await openInbox(page);
    await expectNoAxeViolations(page);

    // A plain-text message exercises the reader without the sandboxed frame.
    await page.locator("[data-message-row='m-007']").click();
    await expect(
      page.getByRole("region", { name: "Message reader" }).getByRole("heading", {
        level: 2,
      }),
    ).toHaveText("Plain text reply");
    await expectNoAxeViolations(page);

    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Contrast is a property of the settled surface: during the fade-in the
    // dialog is still translucent over the overlay, which would read as a
    // phantom background blend.
    await expect
      .poll(() => page.evaluate(() => Number(getComputedStyle(document.querySelector("[role='dialog']") ?? document.body).opacity)))
      .toBe(1);
    await expectNoAxeViolations(page);
  });

  test("the dark palette passes", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("mailhub.theme", "dark");
    });
    await openInbox(page);
    await expect(page.locator("html")).toHaveClass(/dark/u);
    await expectNoAxeViolations(page);
  });
});

test.describe("screen-reader semantics", () => {
  test("landmarks, labels, live regions, and selection state", async ({ page }) => {
    await openInbox(page);

    // Landmarks and headings a screen reader navigates by.
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Mail navigation" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Inbox message list" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Mail", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Inbox", exact: true })).toBeVisible();

    // The search field carries a label, not just a placeholder.
    await expect(page.getByLabel("Search mail")).toBeVisible();

    // Every visible header control names itself.
    const named = await page.locator("header button").evaluateAll((buttons) =>
      buttons.every((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "").length > 0),
    );
    expect(named).toBe(true);

    // Selection announces politely, and the row carries its state.
    await page.keyboard.press("j");
    await expect(
      page.locator("p[role='status']").filter({ hasText: /^Selected: /u }),
    ).toHaveText("Selected: Dinner on Saturday");
    await expect(page.locator("[data-message-row='m-001']")).toHaveAttribute(
      "aria-current",
      "true",
    );

    // Row state is never carried by color alone: the unread dot has text.
    await expect(page.locator("[data-message-row='m-001']")).toContainText("Unread");
    await expect(page.locator("[data-message-row='m-004']")).toContainText("Starred");
  });
});

test.describe("keyboard focus", () => {
  test("every keyboard focus stop paints a visible ring", async ({ page }) => {
    await openInbox(page);

    const outlineFailures: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) {
          return null;
        }
        const style = getComputedStyle(active);
        return {
          label: active.getAttribute("aria-label") ?? active.textContent?.trim() ?? active.tagName,
          style: style.outlineStyle,
          width: style.outlineWidth,
        };
      });
      if (stop === null) {
        continue;
      }
      const width = Number.parseFloat(stop.width);
      if (stop.style === "none" || !Number.isFinite(width) || width < 2) {
        outlineFailures.push(`${stop.label}: ${stop.style} ${stop.width}`);
      }
    }
    expect(outlineFailures, `focus stops without a visible ring: ${outlineFailures.join("; ")}`).toEqual([]);
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("movement and skeleton pulses stop under reduced motion", async ({ page }) => {
    await openInbox(page);

    expect(
      await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches),
    ).toBe(true);

    const durations = await page.evaluate(() => {
      const probe = (classes: string) => {
        const element = document.createElement("div");
        element.className = classes;
        document.body.append(element);
        const style = getComputedStyle(element);
        const duration = style.transitionDuration === "none" ? 0 : Number.parseFloat(style.transitionDuration);
        const animation = style.animationDuration === "none" ? 0 : Number.parseFloat(style.animationDuration);
        element.remove();
        return { duration, animation };
      };
      return {
        // The pane slide token, and the skeleton pulse the loading state uses.
        panel: probe("transition-transform duration-panel"),
        skeleton: probe("animate-pulse"),
        control: probe("transition-colors duration-control"),
      };
    });
    // The reduced-motion rule forces 0.01ms; anything measurable is a leak.
    expect(durations.panel.duration).toBeLessThan(0.001);
    expect(durations.skeleton.animation).toBeLessThan(0.001);
    expect(durations.control.duration).toBeLessThan(0.001);
  });
});

test.describe("responsive layout", () => {
  test("320 px reflow keeps every control without horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openInbox(page);

    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Commands/u })).toBeVisible();

    // Navigation stays reachable through the menu button.
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("navigation", { name: "Mail navigation" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Projects", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Inbox", exact: true }).click();
    await expect(page.getByRole("region", { name: "Inbox message list" })).toBeVisible();

    // The long subject and address truncate instead of widening the shell.
    await expect(page.locator("[data-message-row='m-002']")).toBeVisible();
    await expect(page.locator("[data-message-row='m-003']")).toBeVisible();
    await expect(page.locator("[data-message-row='m-002']")).toContainText("Quarterly budget");

    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1);

    // A message opens and returns at this width.
    await page.locator("[data-message-row='m-002']").click();
    await expect(
      page.getByRole("button", { name: "Back to the message list" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Back to the message list" }).click();
    await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  });

  test("200% text zoom keeps the shell reflowed and operable", async ({ page }) => {
    // The SPEC reviews zoom beside the 320 px reflow above, which covers the
    // 100% baseline. Doubling the root font at the 768 px reference width
    // scales every rem-based size the way text zoom does, while the shell
    // still holds reviewable proportions.
    await page.setViewportSize({ width: 768, height: 1024 });
    await openInbox(page);

    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await page.waitForTimeout(150);

    // Relative units double the text; the shell still fits the viewport.
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1);

    await expect(page.getByRole("button", { name: /^Commands/u })).toBeVisible();
    await page.getByRole("button", { name: /^Commands/u }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("one pane at a time below 1024 px, three panes at 1440 px", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await openInbox(page);

    const offscreen = async () =>
      page.evaluate(() => ({
        nav: document.querySelector("nav[aria-label='Mail navigation']")?.getBoundingClientRect().x ?? 0,
        reader: document
          .querySelector("section[aria-label='Message reader']")
          ?.getBoundingClientRect().x ?? 0,
        viewport: window.innerWidth,
      }));
    let boxes = await offscreen();
    expect(boxes.nav).toBeLessThan(0);
    expect(boxes.reader).toBeGreaterThanOrEqual(boxes.viewport);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.querySelector("nav[aria-label='Mail navigation']")?.getBoundingClientRect().x ?? -1))
      .toBeGreaterThanOrEqual(0);
    boxes = await offscreen();
    expect(boxes.reader).toBeGreaterThanOrEqual(0);
    expect(boxes.reader).toBeLessThan(boxes.viewport);
  });
});

test.describe("touch targets", () => {
  test("mobile icon controls keep a 44 px target", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openInbox(page);

    const below44 = await page.evaluate(() => {
      const failures: string[] = [];
      const check = (element: Element) => {
        const box = element.getBoundingClientRect();
        const name = element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName;
        if (box.height < 44 || box.width < 44) {
          failures.push(`${name}: ${Math.round(box.width)}x${Math.round(box.height)}`);
        }
      };
      // The controls the mobile workflow depends on (SPEC F12).
      for (const selector of [
        "header button[aria-label='Open navigation']",
        "header button[aria-label^='Commands']",
        "header button[aria-label^='Theme']",
        "#message-list button[aria-label='Refresh this view']",
      ]) {
        const element = document.querySelector(selector);
        if (element !== null) {
          check(element);
        }
      }
      return failures;
    });
    expect(below44, `controls under 44 px: ${below44.join("; ")}`).toEqual([]);

    // The reader's back control meets the same floor.
    await page.locator("[data-message-row='m-001']").click();
    const back = page.getByRole("button", { name: "Back to the message list" });
    await expect(back).toBeVisible();
    const box = (await back.boundingBox()) ?? { width: 0, height: 0 };
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  });

  test("every visible control clears the 24 px WCAG minimum", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openInbox(page);

    const below24 = await page.evaluate(() => {
      const failures: string[] = [];
      for (const element of Array.from(document.querySelectorAll("button, a, input"))) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) {
          continue;
        }
        const name = element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName;
        if (box.height < 24 || box.width < 24) {
          failures.push(`${name}: ${Math.round(box.width)}x${Math.round(box.height)}`);
        }
      }
      return failures;
    });
    expect(below24, `controls under 24 px: ${below24.join("; ")}`).toEqual([]);
  });
});

test.describe("theme", () => {
  test("switching through the palette repaints without a reload", async ({ page }) => {
    await openInbox(page);
    const lightBackground = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor,
    );

    const switchTheme = async (choice: string) => {
      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await page.keyboard.type("theme");
      await page.keyboard.press("Enter");
      await dialog.getByRole("option", { name: choice, exact: true }).click();
      await expect(dialog).toBeHidden();
    };

    await switchTheme("Dark");
    await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/u);
    const darkBackground = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor,
    );
    expect(darkBackground).not.toBe(lightBackground);

    await switchTheme("Light");
    await expect(page.locator("html")).not.toHaveClass(/dark/u);
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe(lightBackground);
  });
});
