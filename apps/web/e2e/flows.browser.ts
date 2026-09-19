import { expect, test, type Page } from "@playwright/test";
import { openInbox, selectedRowId, selectionAnnouncement } from "./helpers";

/*
 * Browser workflows (SPEC section 12, "Interface acceptance"): keyboard
 * triage, the command palette chord with its focus contract, single-key
 * guards, offline fallback to downloaded mail, and palette latency against
 * a bounded list. Runs against the production build over the fixture API.
 */

/** Every `/api` request issued inside one measured window. */
function trackApiRequests(page: Page): { count: () => number } {
  let requests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) {
      requests += 1;
    }
  });
  return { count: () => requests };
}

test.describe("keyboard triage", () => {
  test("j, k, and o move, open, and announce the selection", async ({ page }) => {
    await openInbox(page);

    expect(await selectedRowId(page)).toBeNull();

    await page.keyboard.press("j");
    expect(await selectedRowId(page)).toBe("m-001");
    await expect(selectionAnnouncement(page)).toHaveText(
      "Selected: Dinner on Saturday",
    );

    await page.keyboard.press("j");
    expect(await selectedRowId(page)).toBe("m-002");
    await expect(selectionAnnouncement(page)).toContainText("Quarterly budget");

    await page.keyboard.press("k");
    expect(await selectedRowId(page)).toBe("m-001");

    await page.keyboard.press("o");
    const reader = page.getByRole("region", { name: "Message reader" });
    await expect(reader.getByRole("heading", { level: 2 })).toHaveText(
      "Dinner on Saturday",
    );
    // The list keeps the selection while the reader shows the message.
    expect(await selectedRowId(page)).toBe("m-001");
  });

  test("slash focuses the search box", async ({ page }) => {
    await openInbox(page);

    await page.keyboard.press("/");
    await expect(page.getByLabel("Search mail")).toBeFocused();
  });

  test("mobile back navigation returns to the list with the selection", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openInbox(page);

    await page.locator("[data-message-row='m-001']").click();
    await expect(
      page.getByRole("button", { name: "Back to the message list" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Message reader" }).getByRole("heading", {
        level: 2,
      }),
    ).toHaveText("Dinner on Saturday");

    await page.getByRole("button", { name: "Back to the message list" }).click();
    await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
    expect(await selectedRowId(page)).toBe("m-001");
  });
});

test.describe("command palette", () => {
  test("the chord opens, filters locally, and never issues a request", async ({
    page,
  }) => {
    await openInbox(page);
    await page.waitForLoadState("networkidle");
    const api = trackApiRequests(page);

    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Commands");
    // Focus lands on the query input immediately.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("placeholder")))
      .toBe("Type a command…");

    // Word-prefix filtering stays local: one command narrows, garbage empties.
    await page.keyboard.type("inbox");
    await expect(dialog.getByText("Go to Inbox")).toBeVisible();
    await expect(dialog.getByText("Go to All Mail")).toBeHidden();

    await page.keyboard.press("Control+a");
    await page.keyboard.type("zzzz");
    await expect(dialog.getByText("No matching commands.")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Opening and filtering the palette is pure local work (SPEC F11).
    await page.waitForTimeout(200);
    expect(api.count()).toBe(0);
  });

  test("escape leaves a nested choice before closing, then focus returns", async ({
    page,
  }) => {
    await openInbox(page);
    await page.keyboard.press("j");
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await page.keyboard.type("theme");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("placeholder")))
      .toBe("Search theme…");

    // The first Escape leaves the choice; the dialog stays open.
    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("placeholder")))
      .toBe("Type a command…");
    await expect(dialog).toBeVisible();

    // The second Escape closes, and focus returns to the selected row.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-message-row")))
      .toBe("m-001");
  });

  test("a palette opened from the Commands button returns there", async ({ page }) => {
    await openInbox(page);
    const commands = page.getByRole("button", { name: /^Commands/u });
    await commands.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(commands).toBeFocused();
  });
});

test.describe("single-key guards", () => {
  test("single keys stay inert while text is being entered", async ({ page }) => {
    await openInbox(page);

    await page.getByLabel("Search mail").click();
    await page.keyboard.type("jk");
    expect(await selectedRowId(page)).toBeNull();

    // Clearing the box restores the scope, not a stray selection.
    await page.keyboard.press("Control+a");
    await page.keyboard.type("dinner");
    await expect(page.locator("[data-message-row='m-001']")).toBeVisible();
    expect(await selectedRowId(page)).toBeNull();
  });

  test("single keys stay inert while the palette dialog is open", async ({ page }) => {
    await openInbox(page);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("j");
    expect(await selectedRowId(page)).toBeNull();
  });

  test("the shortcut switch turns single keys off and keeps the chord", async ({
    page,
  }) => {
    await openInbox(page);

    await page.keyboard.press("Control+k");
    await page.keyboard.type("single-key");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.keyboard.press("j");
    expect(await selectedRowId(page)).toBeNull();

    // The modifier chord is not a single-key shortcut; it still works.
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});

test.describe("message actions", () => {
  test("opening reads, s stars, and e archives through the server", async ({ page }) => {
    await openInbox(page);

    await page.keyboard.press("j");
    const row = page.locator("[data-message-row='m-001']");
    await expect(row).toContainText("Unread");

    // Opening the reader marks the message seen once (SPEC F4).
    await page.keyboard.press("o");
    await expect(
      page.getByRole("region", { name: "Message reader" }).getByRole("heading", { level: 2 }),
    ).toHaveText("Dinner on Saturday");
    await expect(row).not.toContainText("Unread");

    // The star paints only after the receipts confirm (SPEC F2).
    await page.keyboard.press("s");
    await expect(page.getByText("Starred.", { exact: true })).toBeVisible();
    await expect(row).toContainText("Starred");

    // Archive files the row out of the inbox, on the server and locally.
    await page.keyboard.press("e");
    await expect(page.getByText("Archived.", { exact: true })).toBeVisible();
    await expect(row).toBeHidden();

    await page.getByRole("button", { name: "Refresh this view" }).click();
    await expect(row).toBeHidden();
  });

  test("move opens a destination chooser and files the row", async ({ page }) => {
    await openInbox(page);
    await page.locator("[data-message-row='m-007']").click();

    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await page.keyboard.type("move");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("placeholder")))
      .toBe("Search move to folder…");

    // The chooser names every folder but the source (SPEC F4).
    await expect(dialog.getByRole("option", { name: "Sent" })).toBeVisible();
    const drafts = dialog.getByRole("option", { name: "Drafts", exact: true });
    await expect(drafts).toBeVisible();
    await expect(dialog.getByRole("option", { name: "INBOX" })).toBeHidden();

    await drafts.click();
    await expect(page.getByText("Moved.", { exact: true })).toBeVisible();
    await expect(page.locator("[data-message-row='m-007']")).toBeHidden();

    await page.getByRole("button", { name: "Refresh this view" }).click();
    await expect(page.locator("[data-message-row='m-007']")).toBeHidden();
  });

  test("an action taken offline queues here and replays on return", async ({
    page,
    context,
  }) => {
    await openInbox(page);
    // Read the message once, so its star is the marker the row can show.
    await page.locator("[data-message-row='m-001']").click();
    await expect(page.locator("[data-message-row='m-001']")).not.toContainText("Unread");

    await context.setOffline(true);
    await page.keyboard.press("s");
    await expect(
      page.getByText("Offline. The action is queued on this device and replays on return."),
    ).toBeVisible();
    // Nothing flips before the server confirms (SPEC F2, F9).
    await expect(page.locator("[data-message-row='m-001']")).not.toContainText("Starred");

    // Register the wait before connectivity returns, so the replay cannot
    // slip past it, and let it settle before the view refetches.
    const replay = page.waitForRequest(
      (request) => request.url().includes("/api/actions") && request.method() === "POST",
    );
    await context.setOffline(false);
    await (await replay).response();
    await page.getByRole("button", { name: "Refresh this view" }).click();
    await expect(page.locator("[data-message-row='m-001']")).toContainText("Starred");
  });
});

test.describe("offline", () => {
  test("offline reads fall back to downloaded mail and come back", async ({
    page,
    context,
  }) => {
    await openInbox(page);
    // Open both messages once, so their details and rows sit in the offline
    // store (SPEC F9).
    await page.locator("[data-message-row='m-001']").click();
    await expect(
      page.getByRole("region", { name: "Message reader" }).getByRole("heading", {
        level: 2,
      }),
    ).toHaveText("Dinner on Saturday");
    await page.locator("[data-message-row='m-002']").click();
    await expect(
      page.getByRole("region", { name: "Message reader" }).getByRole("heading", {
        level: 2,
      }),
    ).toContainText("Quarterly budget");

    await context.setOffline(true);
    // The chip is the persistent offline signal in the header.
    await expect(page.locator("header button[aria-label^='Offline.']")).toBeVisible();

    // A refresh that cannot reach the server keeps downloaded mail legible.
    await page.getByRole("button", { name: "Refresh this view" }).click();
    await expect(page.getByText("Offline. Showing downloaded mail.")).toBeVisible();
    await expect(page.locator("[data-message-row='m-001']")).toBeVisible();

    // A message fetched before reads from its downloaded copy.
    await page.locator("[data-message-row='m-001']").click();
    await expect(
      page.getByText("Offline. Showing the copy downloaded earlier."),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Message reader" }).getByRole("heading", {
        level: 2,
      }),
    ).toHaveText("Dinner on Saturday");

    // Connectivity returns: the offline banners leave with a clean refresh.
    await context.setOffline(false);
    await page.getByRole("button", { name: "Refresh this view" }).click();
    await expect(page.getByText("Offline. Showing downloaded mail.")).toBeHidden();
    // Opening another message refetches its detail from the server.
    await page.locator("[data-message-row='m-002']").click();
    await expect(
      page.getByRole("region", { name: "Message reader" }).getByRole("heading", {
        level: 2,
      }),
    ).toContainText("Quarterly budget");
    await expect(
      page.getByText("Offline. Showing the copy downloaded earlier."),
    ).toBeHidden();
    await expect(page.locator("[data-message-row='m-001']")).toBeVisible();
  });
});

test.describe("clean view", () => {
  test("the toggle swaps the extracted view and back", async ({ page }) => {
    await openInbox(page);
    await page.locator("[data-message-row='m-005']").click();
    const reader = page.getByRole("region", { name: "Message reader" });
    await expect(reader.getByRole("heading", { level: 2 })).toHaveText(
      "Weekly report with chart",
    );

    // The sanitized original renders first, nested quotes and all.
    const frame = page.frameLocator("iframe[title='Message body']");
    await expect(frame.locator("body")).toContainText("The oldest message of the chain.");

    // One toggle costs exactly one server round trip, and the extracted
    // view keeps the quoted chain as one collapsed block (SPEC F3).
    const requests = trackApiRequests(page);
    await reader.getByRole("button", { name: "Clean view" }).click();
    await expect(frame.locator("body")).toContainText("The latest answer sits on top");
    await expect(frame.locator("body")).toContainText("An older reply quoted here.");
    expect(requests.count()).toBe(1);

    // The sanitized original stays one click away.
    await reader.getByRole("button", { name: "Clean view" }).click();
    await expect(frame.locator("body")).toContainText("Meeting notes");
    expect(requests.count()).toBe(1);
  });

  test("a text-only message offers no clean view", async ({ page }) => {
    await openInbox(page);
    await page.locator("[data-message-row='m-003']").click();
    const reader = page.getByRole("region", { name: "Message reader" });
    await expect(reader.getByRole("heading", { level: 2 })).toHaveText(
      "Contract draft for review",
    );
    await expect(reader.getByRole("button", { name: "Clean view" })).toBeHidden();
  });
});

test.describe("settings", () => {
  /** Opens the settings screen through the palette (SPEC F11). */
  async function openSettings(page: Page) {
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog");
    await expect(palette).toBeVisible();
    await page.keyboard.type("settings");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test("the screen shows preferences, accounts, and the sync status", async ({ page }) => {
    await openInbox(page);
    const dialog = await openSettings(page);

    // The sections the SPEC F10 settings cover are all present.
    for (const name of [
      "Appearance",
      "Keyboard and reading",
      "Classification",
      "Accounts",
      "Synchronization and queues",
    ]) {
      await expect(dialog.getByRole("heading", { name, exact: true })).toBeVisible();
    }

    // The per-account status and the queue counters come from one read.
    await expect(dialog.getByText("Last cycle 2 min ago")).toBeVisible();
    await expect(dialog.getByText(/3 bodies pending/u)).toBeVisible();
    await expect(dialog.getByText("2 folders still backfilling")).toBeVisible();
    await expect(dialog.getByText("2 jobs waiting")).toBeVisible();
    await expect(dialog.getByText(/1 queued/u)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("a density change applies at once, saves, and survives a reload", async ({ page }) => {
    await openInbox(page);
    await expect(page.locator("html")).not.toHaveAttribute("data-density", "comfortable");
    const dialog = await openSettings(page);

    await dialog.getByLabel("Reading density").click();
    // Radix portals the option list outside the dialog element.
    await page.getByRole("option", { name: "Comfortable" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-density", "comfortable");
    await expect(dialog.locator("footer[role='status']")).toHaveText("Saved.");

    // The server is the record: with local storage emptied, a reload adopts
    // the stored choice (SPEC F10).
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expect(page.locator("#message-list [data-message-row]").first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-density", "comfortable");

    // Compact returns the same way.
    const reopened = await openSettings(page);
    await reopened.getByLabel("Reading density").click();
    await page.getByRole("option", { name: "Compact" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-density", "comfortable");
  });

  test("folder roles, identities, and the classify toggle write through", async ({ page }) => {
    await openInbox(page);
    const dialog = await openSettings(page);

    // A role choice saves and reloads the folder index.
    const projectsRole = dialog.getByLabel("Role of Projects");
    await projectsRole.click();
    await page.getByRole("option", { name: "junk" }).click();
    await expect(projectsRole).toContainText("junk");
    // The list still holds one folder per role; Projects moved, none copied.
    await expect(dialog.getByLabel("Role of Archive")).toContainText("archive");

    // Clearing a required role states what is missing (SPEC F1). The Work
    // card never maps an archive folder, so scope to the Personal card.
    const personalCard = dialog.getByRole("region", { name: "Personal", exact: true });
    await dialog.getByLabel("Role of Archive").click();
    await page.getByRole("option", { name: "No role" }).click();
    await expect(personalCard.getByText(/Choose a destination for archive/u)).toBeVisible();
    await dialog.getByLabel("Role of Archive").click();
    await page.getByRole("option", { name: "archive" }).click();
    await expect(personalCard.getByText(/Choose a destination/u)).toBeHidden();

    // The classify toggle writes and survives the account refetch.
    await dialog.getByRole("switch", { name: "Classify messages of Personal" }).click();
    await expect(dialog.getByRole("switch", { name: "Classify messages of Personal" })).toBeChecked();

    // An identity row saves through the account and re-renders.
    await dialog.getByRole("button", { name: "Add identity" }).first().click();
    await dialog.getByLabel("Address of identity 2").fill("alex+lists@personal.example");
    await dialog.getByLabel("Display name of identity 2").fill("Alex Lists");
    await dialog.getByRole("button", { name: "Save identities" }).first().click();
    await expect(dialog.getByLabel("Address of identity 2")).toHaveValue(
      "alex+lists@personal.example",
    );
    // The stored default stays identity 1.
    await expect(personalCard.getByLabel("Make identity 1 the default")).toBeChecked();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

test.describe("performance", () => {  test("the virtualized list mounts a bounded window of a large scope", async ({
    page,
  }) => {
    await openInbox(page);
    // The fixture holds 100,000 messages; the footer reports the scope.
    await expect(page.locator("#message-list footer p")).toContainText("100,000");

    const mounted = () => page.locator("[data-message-row]").count();
    expect(await mounted()).toBeLessThanOrEqual(30);

    await page.locator("#message-list .overflow-y-auto").first().evaluate((element) => {
      element.scrollTop = 20_000;
    });
    await page.waitForTimeout(300);
    expect(await mounted()).toBeLessThanOrEqual(30);
  });

  test("palette input focus lands within 100 ms of the chord", async ({ page }) => {
    await openInbox(page);
    await page.evaluate(() => {
      window.__paletteTiming = null;
      document.addEventListener(
        "keydown",
        (event) => {
          const chord =
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            (event.key === "k" || event.key === "K");
          if (!chord || window.__paletteTiming !== null) {
            return;
          }
          window.__paletteTiming = { keydown: event.timeStamp, focus: null };
          document.addEventListener(
            "focus",
            (focusEvent) => {
              const timing = window.__paletteTiming;
              if (
                timing !== null &&
                timing.focus === null &&
                focusEvent.target instanceof HTMLInputElement
              ) {
                timing.focus = focusEvent.timeStamp;
              }
            },
            { capture: true },
          );
        },
        { capture: true },
      );
    });

    const samples: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      await page.evaluate(() => {
        window.__paletteTiming = null;
      });
      await page.keyboard.press("Control+k");
      await expect
        .poll(() => page.evaluate(() => window.__paletteTiming?.focus ?? null))
        .not.toBe(null);
      const delta = await page.evaluate(() => {
        const timing = window.__paletteTiming;
        if (timing === null || timing.focus === null) {
          throw new Error("The palette focus probe did not record.");
        }
        return timing.focus - timing.keydown;
      });
      samples.push(delta);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    }

    // The SPEC budget is the 95th percentile under 100 ms; with five runs
    // the maximum stands in for it.
    expect(Math.max(...samples)).toBeLessThan(100);
  });
});
