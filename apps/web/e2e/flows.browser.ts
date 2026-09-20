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

/** The origin the page runs on, which mutations must present (SPEC section 9). */
function pageOrigin(page: Page): string {
  return new URL(page.url()).origin;
}

/** The recovery generation the session probe issued for this context. */
async function readGeneration(page: Page): Promise<string | null> {
  const probe = await page.request.get("/api/accounts");
  const body = (await probe.json()) as { recoveryGeneration?: string | null };
  return body.recoveryGeneration ?? null;
}

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

  test("an archived message returns in All Mail", async ({ page }) => {
    await openInbox(page);

    await page.keyboard.press("j");
    await page.keyboard.press("e");
    await expect(page.getByText("Archived.", { exact: true })).toBeVisible();
    const row = page.locator("[data-message-row='m-001']");
    await expect(row).toBeHidden();

    // All Mail holds every message, archived or not, and the archive overlay
    // retires on the fresh read: nothing stays hidden (SPEC section 4).
    await page.getByRole("button", { name: "All Mail" }).click();
    await expect(row).toBeVisible();
    await expect(row).toContainText("Dinner on Saturday");
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

  test("the offline fallback honors the active query", async ({ page, context }) => {
    await openInbox(page);
    // Download the rows of the scope first, then narrow while still online,
    // so the server result and the offline filter can be told apart.
    await page.locator("[data-message-row='m-001']").click();
    await page.getByLabel("Search mail").fill("dinner");
    await expect(page.locator("[data-message-row='m-001']")).toBeVisible();
    await expect(page.locator("[data-message-row='m-002']")).toBeHidden();

    await context.setOffline(true);
    await page.getByRole("button", { name: "Refresh this view" }).click();
    // The fallback narrows the downloaded rows by the query, and the notice
    // states what an offline search can and cannot cover.
    await expect(
      page.getByText(
        "Offline. Showing downloaded mail that matches the subject, sender, or snippet.",
      ),
    ).toBeVisible();
    await expect(page.locator("[data-message-row='m-001']")).toBeVisible();
    await expect(page.locator("[data-message-row='m-002']")).toBeHidden();
  });

  test("a cold offline load opens the installed shell with downloaded mail", async ({
    page,
    context,
  }) => {
    await openInbox(page);
    // One open visit downloads the rows and the opened detail (SPEC F9).
    await page.locator("[data-message-row='m-001']").click();
    await expect(
      page.getByRole("region", { name: "Message reader" }).getByRole("heading", {
        level: 2,
      }),
    ).toHaveText("Dinner on Saturday");

    // The install surface the browser needs (SPEC F12): the manifest link
    // with icons, and a worker in control of the page.
    const manifest = await page.request.get("/manifest.webmanifest");
    expect(manifest.ok()).toBe(true);
    const parsed = await manifest.json();
    expect(parsed.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable")).toBe(
      true,
    );
    expect(
      await page.evaluate(() => document.querySelector("link[rel='manifest']")?.getAttribute("href")),
    ).toBe("/manifest.webmanifest");
    expect(await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))).toBe(true);

    // The reload starts from nothing: no shell in memory, no session probe
    // answer, and no network. The worker serves the shell from its precache.
    await context.setOffline(true);
    await page.reload();
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    // The cached session and folders boot the app, and the list's fallback
    // paints the downloaded rows instead of an unreachable-service page. The
    // failure itself stays announced beside them (SPEC F12).
    await expect(page.getByRole("heading", { name: "Mail", exact: true })).toBeVisible();
    await expect(page.getByText("Offline. Showing downloaded mail.")).toBeVisible();
    await expect(page.locator("[data-message-row='m-001']")).toBeVisible();

    // A message fetched before the outage still opens from its copy.
    await page.locator("[data-message-row='m-001']").click();
    await expect(
      page.getByText("Offline. Showing the copy downloaded earlier."),
    ).toBeVisible();

    // Connectivity returns and a clean refresh goes back to the server.
    await context.setOffline(false);
    await page.getByRole("button", { name: "Refresh this view" }).click();
    await expect(page.getByText("Offline. Showing downloaded mail.")).toBeHidden();
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

  test("a default-on clean view still turns off for one message", async ({ page }) => {
    await openInbox(page);
    // Turn the stored default on first (SPEC F10), so the reader starts in
    // the extracted view; the per-message choice must still be able to turn
    // it off (SPEC F3: the sanitized original stays one click away).
    const dialog = await openSettings(page);
    await dialog.getByRole("switch", { name: "Clean view by default" }).click();
    await expect(dialog.locator("footer[role='status']")).toHaveText("Saved.");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await page.locator("[data-message-row='m-005']").click();
    const reader = page.getByRole("region", { name: "Message reader" });
    await expect(reader.getByRole("heading", { level: 2 })).toHaveText(
      "Weekly report with chart",
    );
    const frame = page.frameLocator("iframe[title='Message body']");
    await expect(frame.locator("body")).toContainText("The latest answer sits on top");
    const toggle = reader.getByRole("button", { name: "Clean view" });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    // Switching off records the per-message choice, not the default again.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(frame.locator("body")).toContainText("Meeting notes");
    await expect(frame.locator("body")).toContainText("The oldest message of the chain.");

    // The next message starts from the stored default again: its clean view
    // is fetched and the fallback states itself.
    await page.locator("[data-message-row='m-002']").click();
    await expect(reader.getByRole("heading", { level: 2 })).toContainText(
      "Quarterly budget",
    );
    await expect(
      reader.getByText("Extraction found nothing to clean. Showing the sanitized original."),
    ).toBeVisible();
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

  test("every save carries the deployed origin and the recovery generation", async ({ page }) => {
    await openInbox(page);
    const generation = await readGeneration(page);
    expect(generation).not.toBeNull();
    const dialog = await openSettings(page);

    // The deployed API refuses a mutation without the origin and the
    // generation the session probe issued (SPEC sections 7 and 9), so the
    // shipped client must send both on every save.
    const saved = page.waitForRequest(
      (request) => request.url().includes("/api/settings") && request.method() === "PUT",
    );
    await dialog.getByRole("switch", { name: "Clean view by default" }).click();
    const request = await saved;
    // `allHeaders` carries what the browser actually sent, including the
    // implicit Origin a same-origin fetch carries.
    const headers = await request.allHeaders();
    expect(headers.origin).toBe(pageOrigin(page));
    expect(headers["x-recovery-generation"]).toBe(generation);
    await expect(dialog.locator("footer[role='status']")).toHaveText("Saved.");
  });
});

test.describe("sign-in", () => {
  /**
   * A throwaway ECDSA P-256 keypair for the virtual passkey this check
   * seeds. The fixture refuses only a malformed assertion, so a test key
   * stands in for the owner's credential.
   */
  const PASSKEY_PRIVATE_KEY =
    "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgOKbctRMxKl2YQfnyrPEV8aWmPacxdNUWp8QzVEMN0j6hRANCAAQqdbYt_l-Myref_65yrPItLmOH6nzBmuDMb6jiEh7iVJLkni1mIMLchbozW0ZZ1dsfz5sKpEEJ1sfYNM-kgtZR";
  const PASSKEY_PUBLIC_KEY =
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKnW2Lf5fjMq3n_-ucqzyLS5jh-p8wZrgzG-o4hIe4lSS5J4tZiDC3IW6M1tGWdXbH8-bCqRBCdbH2DTPpILWUQ";

  test("an ended session shows the passkey screen and signs back in", async ({ page }) => {
    await openInbox(page);
    const origin = pageOrigin(page);

    // Flip this context into the signed-out state the deployed API answers
    // with when the session cookie is gone or revoked (SPEC section 9).
    const flipped = await page.request.post("/api/fixture/session", {
      data: { signedIn: false },
    });
    expect(flipped.ok()).toBe(true);

    // Reads and writes both refuse without a session.
    expect((await page.request.get("/api/accounts")).status()).toBe(401);
    expect(
      (await page.request.post("/api/actions", { headers: { origin }, data: {} })).status(),
    ).toBe(401);

    // The shell gives way to the sign-in screen (SPEC section 9).
    await page.reload();
    const signIn = page.getByRole("button", { name: "Sign in with a passkey" });
    await expect(signIn).toBeVisible();

    // Seed the virtual passkey with the credential the fixture's login
    // options allow, then let the shipped client run the whole ceremony.
    const start = await page.request.post("/api/auth/login/start", { headers: { origin } });
    expect(start.ok()).toBe(true);
    const options = (
      (await start.json()) as {
        options: { rpId: string; allowCredentials: Array<{ id: string }> };
      }
    ).options;
    await page.context().credentials.create(options.rpId, {
      id: options.allowCredentials[0]!.id,
      userHandle: "b3duZXI",
      privateKey: PASSKEY_PRIVATE_KEY,
      publicKey: PASSKEY_PUBLIC_KEY,
    });
    await page.context().credentials.install();

    await signIn.click();
    await expect(page.locator("#message-list [data-message-row]").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Mail" })).toBeVisible();
  });
});

test.describe("failure and pending states", () => {
  test("a settings save that fails keeps the change and retries on demand", async ({ page }) => {
    await openInbox(page);
    const settingsPattern = "**/api/settings";
    await page.route(settingsPattern, async (route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "internal", message: "The settings store is unavailable." },
          }),
        });
        return;
      }
      await route.continue();
    });
    const dialog = await openSettings(page);
    const footer = dialog.locator("footer[role='status']");

    // The failed save states its reason and offers the explicit retry; the
    // chosen value stays entered meanwhile (SPEC F12).
    const cleanView = dialog.getByRole("switch", { name: "Clean view by default" });
    await cleanView.click();
    await expect(footer).toContainText("Could not save: The settings store is unavailable.");
    await expect(cleanView).toBeChecked();

    await page.unroute(settingsPattern);
    await footer.getByRole("button", { name: "Try again" }).click();
    await expect(footer).toHaveText("Saved.");
    await expect(cleanView).toBeChecked();
  });

  test("a failed list load states the failure and recovers on retry", async ({ page }) => {
    const searchPattern = /\/api\/search/u;
    await page.route(searchPattern, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "internal", message: "The search index is unavailable." },
        }),
      });
    });
    await page.goto("/");

    await expect(page.getByText("This view cannot be loaded.")).toBeVisible();
    // The reason shows beside the retry; the polite region repeats it, so
    // take the visible paragraph the list pane renders.
    await expect(page.locator("#message-list p.max-w-sm")).toHaveText(
      "The search index is unavailable.",
    );

    await page.unroute(searchPattern);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("#message-list [data-message-row]").first()).toBeVisible();
  });

  test("a slow first page shows the skeleton, then the rows", async ({ page }) => {
    await page.route(/\/api\/search/u, async (route) => {
      await page.waitForTimeout(600);
      await route.continue();
    });
    await page.goto("/");

    // The loading state is layout-matched skeletons, not a blank pane
    // (SPEC F12), and the pane announces it is busy.
    await expect(page.locator("#message-list")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#message-list .animate-pulse").first()).toBeVisible();

    await expect(page.locator("#message-list [data-message-row]").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator("#message-list")).not.toHaveAttribute("aria-busy", "true");
  });

  test("a slow refresh keeps the rows on screen", async ({ page }) => {
    await openInbox(page);
    const firstRow = page.locator("#message-list [data-message-row]").first();
    await expect(firstRow).toContainText("Dinner on Saturday");

    await page.route(/\/api\/search/u, async (route) => {
      await page.waitForTimeout(600);
      await route.continue();
    });
    await page.getByRole("button", { name: "Refresh this view" }).click();

    // A refresh of a view already on screen keeps its content visible; the
    // skeletons are for uncached content (SPEC F12). The pane still says it
    // is busy, and the button does not stack a second refresh on top. The
    // mid-refresh checks are single-shot once busy: a retried locator would
    // wait the delay out and pass even against a skeleton flash.
    await expect(page.locator("#message-list")).toHaveAttribute("aria-busy", "true");
    expect(await page.locator("#message-list .animate-pulse").count()).toBe(0);
    expect(await firstRow.isVisible()).toBe(true);
    expect(await firstRow.textContent()).toContain("Dinner on Saturday");

    await expect(page.locator("#message-list")).not.toHaveAttribute("aria-busy", "true", {
      timeout: 10_000,
    });
    await expect(firstRow).toContainText("Dinner on Saturday");
  });

  test("a slow settings save shows the saving state before it settles", async ({ page }) => {
    await openInbox(page);
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "PUT") {
        await page.waitForTimeout(800);
      }
      await route.continue();
    });
    const dialog = await openSettings(page);
    const footer = dialog.locator("footer[role='status']");

    await dialog.getByRole("switch", { name: "Single-key shortcuts" }).click();
    await expect(footer).toHaveText("Saving…");
    await expect(footer).toHaveText("Saved.", { timeout: 10_000 });
  });

  test("a failed folder read surfaces in the unified inbox and recovers", async ({ page }) => {
    // The unified inbox cannot query before its folder roles resolve, so a
    // failed index read must state the failure instead of skeletoning
    // forever, and the retry must retry the folder read itself.
    const foldersPattern = /\/api\/accounts\/[^/]+\/folders$/u;
    await page.route(foldersPattern, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "internal", message: "The folder index is unavailable." },
        }),
      });
    });
    await page.goto("/");

    await expect(page.getByText("This view cannot be loaded.")).toBeVisible();
    await expect(page.locator("#message-list p.max-w-sm")).toHaveText(
      "The folder index is unavailable.",
    );

    await page.unroute(foldersPattern);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("#message-list [data-message-row]").first()).toBeVisible();
  });

  test("an ended session in settings offers sign-in, not a dead retry", async ({ page }) => {
    await openInbox(page);
    const settingsPattern = "**/api/settings";
    await page.route(settingsPattern, async (route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "unauthorized", message: "The session has ended." },
          }),
        });
        return;
      }
      await route.continue();
    });
    const dialog = await openSettings(page);
    const footer = dialog.locator("footer[role='status']");

    // A settings save that fails because the session ended offers the same
    // recovery path the list and reader offer (SPEC F9).
    await dialog.getByRole("switch", { name: "Clean view by default" }).click();
    await expect(footer).toContainText("Could not save: your session ended.");
    await expect(footer.getByRole("button", { name: "Sign in again" })).toBeVisible();
    await expect(footer.getByRole("button", { name: "Try again" })).toBeHidden();
  });
});

test.describe("performance", () => {
  test("the virtualized list mounts a bounded window of a large scope", async ({
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

  test("palette input focus lands within 100 ms of the chord at p95", async ({ page }) => {
    test.setTimeout(60_000);
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

    /** One open-and-close round; returns the chord-to-focus delta in ms. */
    const sample = async (): Promise<number> => {
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
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      return delta;
    };

    // One warm-up round absorbs first-open layout work, the way a person's
    // second use of the chord is the steady state the SPEC measures.
    await sample();

    const samples: number[] = [];
    for (let round = 0; round < 20; round += 1) {
      samples.push(await sample());
    }

    // The SPEC budget is the 95th percentile under 100 ms. Nearest-rank p95
    // over 20 samples drops the single worst round, so one scheduler hiccup
    // on a loaded runner cannot fail the budget the maximum used to.
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(0.95 * samples.length) - 1]!;
    expect(
      p95,
      `chord-to-focus samples (ms): [${samples.join(", ")}]`,
    ).toBeLessThan(100);
  });
});

test.describe("compose and send", () => {
  test.setTimeout(45_000);

  /** Opens the compose surface through the palette's Send command. */
  async function openCompose(page: Page) {
    await page.keyboard.press("Control+k");
    await page.keyboard.type("send");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    return dialog;
  }

  /** Starts one new draft on the named account and waits for its editor. */
  async function startNewDraft(page: Page, account: "Personal" | "Work") {
    const dialog = await openCompose(page);
    await dialog.getByRole("button", { name: "New message" }).click();
    await dialog.getByRole("button", { name: account, exact: true }).click();
    await expect(dialog.getByLabel("To")).toBeVisible();
    return dialog;
  }

  test("a reply derives its draft through the account and identity choices", async ({ page }) => {
    await openInbox(page);
    // A second work identity makes the reply's From choice real (SPEC F6).
    // The request acts as a same-origin client, so it carries the guards
    // the fixture now enforces on every mutation.
    const identities = await page.request.put("/api/accounts/acc-work/identities", {
      headers: {
        origin: pageOrigin(page),
        "x-recovery-generation": (await readGeneration(page)) ?? "",
      },
      data: {
        identities: [
          {
            address: "alexandra.fernandezholmes@work.example",
            name: "Alexandra Fernandez-Holmes",
            isDefault: true,
          },
          { address: "afh@work.example", name: null, isDefault: false },
        ],
      },
    });
    expect(identities.ok()).toBe(true);

    await page.locator("[data-message-row='m-007']").click();
    await page.keyboard.press("r");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The fixture asks for the account first, then the identity (SPEC F6).
    await expect(dialog.getByText("Which account holds the message you reply to?")).toBeVisible();
    await dialog.getByRole("button", { name: "Work" }).click();
    await expect(dialog.getByText("Which identity sends this reply?")).toBeVisible();
    await dialog
      .getByRole("button", { name: /Alexandra Fernandez-Holmes <alexandra/ })
      .click();

    // The derived draft carries the parent's context, quoted below the fold.
    await expect(dialog.getByLabel("To")).toHaveValue("Priya Nair <priya@work.example>");
    await expect(dialog.getByLabel("Subject")).toHaveValue("Re: Plain text reply");
    await expect(dialog.locator(".cm-content")).toContainText("Works for me.");
    await expect(dialog.getByText(/On 2026-09-17/u)).toBeVisible();
  });

  test("edits autosave after two seconds and the preview stays derived", async ({ page }) => {
    await openInbox(page);
    const dialog = await startNewDraft(page, "Personal");
    await expect(dialog.getByTestId("autosave-status")).toHaveText("Saved.");

    const patched = page.waitForRequest(
      (request) => request.method() === "PATCH" && /\/api\/drafts\/d-\d+$/u.test(request.url()),
    );
    await dialog.getByLabel("To").fill("sam@personal.example");
    await dialog.getByLabel("Subject").fill("Hello from the fixture");
    const editor = dialog.locator(".cm-content");
    await editor.click();
    await page.keyboard.type("# Title\n\n<b>raw</b> and nothing else");
    await expect(dialog.getByTestId("autosave-status")).toHaveText(/Saved\.|Saving…/u);
    await (await patched).response();
    await expect(dialog.getByTestId("autosave-status")).toHaveText("Saved.", { timeout: 8_000 });

    // The preview renders the Markdown and escapes the raw markup (SPEC F6).
    const frame = dialog.getByTitle("Markdown preview");
    await expect(frame).toHaveAttribute("srcdoc", /<h1>Title<\/h1>/u);
    await expect(frame).toHaveAttribute("srcdoc", /&lt;b&gt;raw&lt;b&gt;|&lt;b&gt;raw&lt;\/b&gt;/u);

    // The draft outlives the dialog: the list names it after reopening.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    const reopened = await openCompose(page);
    await expect(reopened.getByTestId("draft-list")).toContainText("Hello from the fixture");
  });

  test("attachments upload through the server and detach again", async ({ page }) => {
    await openInbox(page);
    const dialog = await startNewDraft(page, "Personal");

    await dialog.locator("#draft-file-input").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("fixture attachment bytes"),
    });
    const list = dialog.getByTestId("draft-attachments");
    await expect(list).toContainText("notes.txt");
    await expect(list.getByText("Attached")).toBeVisible();

    await dialog.getByRole("button", { name: "Remove notes.txt" }).click();
    // The row leaves with the list once the server confirms the detach.
    await expect(list).toBeHidden();
  });

  test("an offline attachment links to the draft before its send leaves", async ({
    page,
    context,
  }) => {
    await openInbox(page);
    const dialog = await startNewDraft(page, "Personal");
    await dialog.getByLabel("To").fill("sam@personal.example");
    await dialog.getByLabel("Subject").fill("Offline attachment");

    // The file queues on this device; nothing about it is on the server.
    await context.setOffline(true);
    await dialog.locator("#draft-file-input").setInputFiles({
      name: "offline-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("offline attachment bytes"),
    });
    const list = dialog.getByTestId("draft-attachments");
    await expect(list).toContainText("offline-notes.txt");
    await expect(list.getByText("Waits to upload")).toBeVisible();

    // The send cannot leave while the file holds no server link: the editor
    // holds its button, and the queue would refuse the send anyway.
    const send = dialog.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeDisabled();
    await expect(dialog.getByText(/The send queues after 1 file/u)).toBeVisible();

    // On return the bytes upload and the draft links them; only a linked
    // file lets the send leave.
    const uploaded = page.waitForRequest(
      (request) => request.url().includes("/api/uploads") && request.method() === "POST",
    );
    const attached = page.waitForRequest(
      (request) => /\/api\/drafts\/d-\d+\/uploads$/u.test(request.url()) && request.method() === "POST",
    );
    await context.setOffline(false);
    await (await uploaded).response();
    await (await attached).response();
    await expect(list).toContainText("offline-notes.txt");
    await expect(list.getByText("Attached")).toBeVisible();

    await expect(send).toBeEnabled();
    await send.click();
    const status = dialog.getByRole("region", { name: "Send status" });
    await expect(status).toBeVisible({ timeout: 15_000 });

    // Nothing may poll the attachment list once the flow settles: a refresh
    // that re-triggers itself would hammer this route forever.
    let listReads = 0;
    page.on("request", (request) => {
      if (/\/api\/drafts\/d-\d+\/uploads$/u.test(request.url()) && request.method() === "GET") {
        listReads += 1;
      }
    });
    await page.waitForTimeout(600);
    expect(listReads).toBeLessThanOrEqual(2);
  });

  test("a send settles, keeps its states separate from the Sent copy, and locks the draft", async ({
    page,
  }) => {
    await openInbox(page);
    const dialog = await startNewDraft(page, "Personal");
    await dialog.getByLabel("To").fill("priya@work.example");
    await dialog.getByLabel("Subject").fill("Fixture send");

    await dialog.getByRole("button", { name: "Send", exact: true }).click();

    // The attempt and the Sent copy each settle on their own (SPEC F7).
    const status = dialog.getByRole("region", { name: "Send status" });
    await expect(status.getByText("Sent", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(
      status.getByTestId("send-recipients").locator("li").filter({ hasText: "priya@work.example" }),
    ).toContainText("Accepted for delivery.");
    await expect(status.getByText("Stored in Sent")).toBeVisible({ timeout: 15_000 });

    // The locked draft stays in the list with its send one click away.
    await expect(dialog.getByTestId("draft-list").getByText("Locked")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  });

  test("a partial acceptance names the split and offers no retry", async ({ page }) => {
    await openInbox(page);
    const dialog = await startNewDraft(page, "Personal");
    await dialog.getByLabel("To").fill("priya@work.example, noreply.reject@work.example");

    await dialog.getByRole("button", { name: "Send", exact: true }).click();

    const status = dialog.getByRole("region", { name: "Send status" });
    await expect(status.getByText("Partially accepted")).toBeVisible({ timeout: 15_000 });
    const recipients = status.getByTestId("send-recipients");
    await expect(recipients).toContainText("priya@work.example");
    await expect(recipients).toContainText("Rejected: 550 User unknown");
    await expect(status.getByText(/none is offered/u)).toBeVisible();
    await expect(
      status.getByRole("button", { name: "Edit the draft and queue it again" }),
    ).toBeHidden();
  });

  test("a failed send unlocks the draft and offers the edit path", async ({ page }) => {
    await openInbox(page);
    const dialog = await startNewDraft(page, "Personal");
    await dialog.getByLabel("To").fill("noreply.fail@work.example");

    await dialog.getByRole("button", { name: "Send", exact: true }).click();

    const status = dialog.getByRole("region", { name: "Send status" });
    await expect(status.getByText("Failed", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(status.getByText(/draft is editable again/u)).toBeVisible();

    await status.getByRole("button", { name: "Edit the draft and queue it again" }).click();
    await expect(dialog.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  });

  test("an unknown outcome is preserved with no resend offered", async ({ page }) => {
    await openInbox(page);
    const dialog = await startNewDraft(page, "Personal");
    await dialog.getByLabel("To").fill("noreply.unknown@work.example");

    await dialog.getByRole("button", { name: "Send", exact: true }).click();

    const status = dialog.getByRole("region", { name: "Send status" });
    await expect(status.getByText("Outcome unknown")).toBeVisible({ timeout: 15_000 });
    await expect(status.getByText(/preserved for review/u)).toBeVisible();
    await expect(
      status.getByRole("button", { name: "Edit the draft and queue it again" }),
    ).toBeHidden();
    // The draft stays locked with the attempt (SPEC F7).
    await expect(dialog.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  });

  test("an interrupted queue-send shows the duplicate warning before a new key", async ({
    page,
  }) => {
    await openInbox(page);
    const dialog = await startNewDraft(page, "Personal");
    await dialog.getByLabel("To").fill("sam@personal.example");

    // The first queue-send request dies on the network; the second goes out
    // with a fresh idempotency key after the warning is acknowledged.
    let interrupted = false;
    await page.route(/\/api\/drafts\/d-\d+\/send$/u, async (route) => {
      if (!interrupted) {
        interrupted = true;
        await route.abort("connectionreset");
        return;
      }
      await route.continue();
    });

    await dialog.getByRole("button", { name: "Send", exact: true }).click();
    const warning = dialog.getByTestId("uncertain-send");
    await expect(warning).toBeVisible();
    await expect(warning.getByText(/may deliver a duplicate/u)).toBeVisible();

    // The resend stays inert until the warning is acknowledged (SPEC F7).
    const resend = warning.getByRole("button", { name: "Send again with a new key" });
    await expect(resend).toBeDisabled();
    await warning.getByRole("checkbox").check();
    await expect(resend).toBeEnabled();

    await resend.click();
    const status = dialog.getByRole("region", { name: "Send status" });
    await expect(status).toBeVisible({ timeout: 15_000 });
  });
});
