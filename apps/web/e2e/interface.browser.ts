import { expect, test, type Page } from "@playwright/test";
import { axeViolations, describeViolations, openHome, openInbox } from "./helpers";

/*
 * Interface checks (SPEC F12 and section 12, "Interface acceptance"):
 * axe scans in both palettes, screen-reader semantics, visible keyboard
 * focus, reduced motion, reflow at 320 px and 200% text zoom, touch
 * targets, pane layouts, theme switching, and the Home overview (SPEC
 * F13). Runs against the production build over the fixture API.
 */

/**
 * Tolerance for sub-pixel noise in size checks. Chromium reports rects that
 * pass through a compositor transform (the translated mobile panes) with
 * float32 precision, so a 44 px target can measure 44 minus two units in the
 * last place. One hundredth of a pixel absorbs that noise and still fails
 * any real shortfall.
 */
const SUBPIXEL = 0.01;

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
    await openInbox(page);
    // Turn the theme dark through the application's own control. The stored
    // choice is the record, and it wins over any local seed (SPEC F10).
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog");
    await expect(palette).toBeVisible();
    await page.keyboard.type("theme");
    await page.keyboard.press("Enter");
    await palette.getByRole("option", { name: "Dark", exact: true }).click();
    await expect(palette).toBeHidden();
    await expect(page.locator("html")).toHaveClass(/dark/u);
    await expectNoAxeViolations(page);
  });

  test("the settings screen passes", async ({ page }) => {
    await openInbox(page);
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog");
    await expect(palette).toBeVisible();
    await page.keyboard.type("settings");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    // The account cards carry the densest controls: selects, switches, and
    // the identity radio group.
    await expect(dialog.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
    // Contrast is a property of the settled surface: during the fade-in the
    // dialog is still translucent over the overlay.
    await expect
      .poll(() =>
        page.evaluate(() =>
          Number(getComputedStyle(document.querySelector("[role='dialog']") ?? document.body).opacity),
        ),
      )
      .toBe(1);
    await expectNoAxeViolations(page);
  });

  test("the compose surface passes", async ({ page }) => {
    await openInbox(page);
    await page.keyboard.press("Control+k");
    await page.keyboard.type("send");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "New message" }).click();
    await dialog.getByRole("button", { name: "Personal", exact: true }).click();
    // The editor holds the densest compose controls: the identity picker,
    // the recipient inputs, the CodeMirror source, and the preview frame.
    await expect(dialog.getByLabel("Draft body in Markdown")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Number(getComputedStyle(document.querySelector("[role='dialog']") ?? document.body).opacity),
        ),
      )
      .toBe(1);
    await expectNoAxeViolations(page);
  });

  test("the active and completed work lists pass accessibility checks", async ({ page }) => {
    await openHome(page);
    await page.getByRole("button", {name: "Active work", exact: true}).click();
    await expect(page.getByRole("region", {name: "Active work", exact: true}).getByRole("button", {name: "Done", exact: true})).toBeVisible();
    let violations = await axeViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);
    await page.getByRole("region", {name: "Active work", exact: true}).getByRole("button", {name: "Done", exact: true}).click();
    await page.getByRole("button", {name: "Completed work", exact: true}).click();
    await expect(page.getByRole("region", {name: "Completed work", exact: true}).getByRole("button", {name: "Reopen", exact: true})).toBeVisible();
    violations = await axeViolations(page);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  test("the Home overview and its reminder chooser pass", async ({ page }) => {
    await openHome(page);
    await expectNoAxeViolations(page);

    // The chooser and the expanded Saved rows hold the densest Home
    // controls: presets, a datetime field, and per-row work lines.
    await page.getByRole("button", { name: "Show 1 starred" }).click();
    await page
      .locator("[data-home-entry='thread-m-003']")
      .getByRole("button", { name: "Remind me" })
      .click();
    await expect(page.getByRole("group", { name: "Choose a reminder time" })).toBeVisible();
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

  test("the Home overview names its landmarks, sections, and reason origins", async ({ page }) => {
    await openHome(page);

    // Landmarks and headings a screen reader navigates by (SPEC F13).
    await expect(page.getByRole("region", { name: "Home" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Home", exact: true })).toBeVisible();
    for (const name of ["Due now", "Needs attention", "Since your last visit", "Saved"]) {
      await expect(page.getByRole("region", { name })).toBeVisible();
      await expect(page.getByRole("heading", { level: 3, name, exact: true })).toBeVisible();
    }

    // A reason chip spells out its origin, so a screen reader hears whether
    // a row is your choice or only a suggestion (SPEC F13).
    await expect(
      page
        .locator("[data-home-entry='thread-m-001']")
        .locator("span")
        .filter({ hasText: "May need your reply" }),
    ).toHaveText(/^Suggestion: May need your reply$/u);
    await page.getByRole("button", { name: "Show 1 starred" }).click();
    await expect(
      page
        .locator("[data-home-entry='thread-m-004']")
        .locator("span")
        .filter({ hasText: "You starred this" }),
    ).toHaveText(/^Your choice: You starred this$/u);

    // The coverage line states how far the suggestions reach.
    await expect(page.getByText(/Stored answers cannot promise/u)).toBeVisible();
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
    // The inactive reader sits at translate-x-full, a compositor transform:
    // its rect can lose sub-pixel precision on the way back (see SUBPIXEL).
    expect(boxes.reader).toBeGreaterThanOrEqual(boxes.viewport - SUBPIXEL);

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

    const below44 = await page.evaluate((epsilon: number) => {
      const failures: string[] = [];
      const check = (element: Element) => {
        const box = element.getBoundingClientRect();
        const name = element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName;
        if (box.height < 44 - epsilon || box.width < 44 - epsilon) {
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
    }, SUBPIXEL);
    expect(below44, `controls under 44 px: ${below44.join("; ")}`).toEqual([]);

    // The reader's back control meets the same floor.
    await page.locator("[data-message-row='m-001']").click();
    const back = page.getByRole("button", { name: "Back to the message list" });
    await expect(back).toBeVisible();
    const box = (await back.boundingBox()) ?? { width: 0, height: 0 };
    expect(box.height).toBeGreaterThanOrEqual(44 - SUBPIXEL);
    expect(box.width).toBeGreaterThanOrEqual(44 - SUBPIXEL);
  });

  test("every visible control clears the 24 px WCAG minimum", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openInbox(page);

    const below24 = await page.evaluate((epsilon: number) => {
      const failures: string[] = [];
      for (const element of Array.from(document.querySelectorAll("button, a, input"))) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) {
          continue;
        }
        const name = element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName;
        if (box.height < 24 - epsilon || box.width < 24 - epsilon) {
          failures.push(`${name}: ${Math.round(box.width)}x${Math.round(box.height)}`);
        }
      }
      return failures;
    }, SUBPIXEL);
    expect(below24, `controls under 24 px: ${below24.join("; ")}`).toEqual([]);
  });

  test("every visible Home control clears the 24 px WCAG minimum", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openHome(page);
    // Open the densest surface the overview offers: the expanded Saved
    // rows and the reminder chooser (SPEC F13).
    await page.getByRole("button", { name: "Show 1 starred" }).click();
    await page
      .locator("[data-home-entry='thread-m-003']")
      .getByRole("button", { name: "Remind me" })
      .click();
    await expect(page.getByRole("group", { name: "Choose a reminder time" })).toBeVisible();

    const below24 = await page.evaluate((epsilon: number) => {
      const failures: string[] = [];
      for (const element of Array.from(document.querySelectorAll("button, a, input"))) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) {
          continue;
        }
        const name = element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName;
        if (box.height < 24 - epsilon || box.width < 24 - epsilon) {
          failures.push(`${name}: ${Math.round(box.width)}x${Math.round(box.height)}`);
        }
      }
      return failures;
    }, SUBPIXEL);
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

test.describe("visual regression", () => {
  /*
   * Snapshot baselines for the shared surfaces and the main flows (SPEC
   * section 12). Animations settle and the text caret hides, so only a real
   * change moves a pixel; the draft footer is masked because it names the
   * wall-clock edit time.
   */

  /** Screenshot options every baseline shares. */
  const SHOT = { animations: "disabled" as const, caret: "hide" as const };

  test("the shell, reader, palette, settings, compose, and dark theme", async ({ page }) => {
    await openInbox(page);
    await expect(page).toHaveScreenshot("inbox-light.png", SHOT);

    // The reader with a sanitized HTML body in the sandboxed frame (SPEC F3).
    await page.locator("[data-message-row='m-005']").click();
    await expect(
      page.getByRole("region", { name: "Message reader" }).getByRole("heading", { level: 2 }),
    ).toHaveText("Weekly report with chart");
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot("reader-html-message.png", SHOT);

    // The command palette over the list (SPEC F11).
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot("command-palette.png", SHOT);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });

    // The settings screen: the shared selects, switches, and cards (F10).
    await page.keyboard.press("Control+k");
    await page.keyboard.type("settings");
    await page.keyboard.press("Enter");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot("settings.png", SHOT);
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "hidden" });

    // The compose surface: inputs, CodeMirror source, preview frame (F6).
    await page.keyboard.press("Control+k");
    await page.keyboard.type("send");
    await page.keyboard.press("Enter");
    const compose = page.getByRole("dialog");
    await expect(compose).toBeVisible();
    await compose.getByRole("button", { name: "New message" }).click();
    await compose.getByRole("button", { name: "Personal", exact: true }).click();
    await expect(compose.getByLabel("Draft body in Markdown")).toBeVisible();
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot("compose.png", {
      ...SHOT,
      // The footer and each drafts row name the wall-clock edit time; mask
      // the times, not the layout.
      mask: [compose.locator("footer p"), compose.locator("[data-testid='draft-list'] time")],
    });
    await page.keyboard.press("Escape");
    await compose.waitFor({ state: "hidden" });

    // Dark repaints the same shell without a reload (SPEC F12).
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog");
    await expect(palette).toBeVisible();
    await page.keyboard.type("theme");
    await page.keyboard.press("Enter");
    await palette.getByRole("option", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/u);
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot("inbox-dark.png", SHOT);
  });

  test("the passkey sign-in screen", async ({ page }) => {
    await openInbox(page);
    const flipped = await page.request.post("/api/fixture/session", {
      data: { signedIn: false },
    });
    expect(flipped.ok()).toBe(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
    await expect(page).toHaveScreenshot("sign-in.png", SHOT);
  });

  test("the Home overview", async ({ page }) => {
    await openHome(page);
    // The updated line names the wall-clock generation time; mask the age,
    // not the layout (SPEC F13).
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot("home.png", {
      ...SHOT,
      mask: [page.getByText(/ · All accounts$/u).first()],
    });
  });
});
