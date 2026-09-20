# Device and browser matrix

SPEC F12 and the section 12 acceptance list require recording the browsers
and operating systems a release check ran on, and require Safari on macOS
plus a real iPhone with the installed PWA before those platforms count as
validated. This file is that record. Add one row per run; never delete a
row to make coverage look better.

## Recorded runs

| Date | Device | Operating system | Browser | What ran | Result |
| --- | --- | --- | --- | --- | --- |
| 2026-09-20 | Development container | Linux 6.8 | Playwright Chromium, build `chromium-1243` (`@playwright/test` 1.63.0) | `flows` and `interface` suites from the release gate, 1280×800, `en-US`, UTC | Pass |

What that row covers: keyboard triage, the palette chord and its latency
budget, the offline fallback against the fixture server, axe contrast and
semantics, focus visibility, emulated reduced motion, narrow reflow, 200%
zoom, touch target sizes, theme switching, and the committed visual
baselines.

## Not tested anywhere yet

These platforms have no recorded run. Treat every claim about them as
unverified until a row appears above:

- Safari on macOS: WebKit rendering, `⌘K` platform symbols, focus rings.
- Chromium on macOS (the SPEC names it beside Safari).
- A real iPhone: iOS Safari and the installed PWA, safe areas, the software
  keyboard over compose and the palette, back navigation restoring list
  position and selection, 44px touch targets under a real finger, and
  evening reading in the dark appearance.
- Firefox, and any browser on Windows.
- Offline on real hardware: the suites simulate it through the fixture
  server, not airplane mode on a device.
- Slow networks on real hardware.

## Running the suites on other hardware

The suites serve the production `dist` build through the fixture server, so
they follow the browser Playwright is told to use. On macOS, with that
browser installed:

    cd apps/web
    E2E_BROWSER_CHANNEL=safari npx playwright test --project=flows
    E2E_BROWSER_CHANNEL=safari npx playwright test --project=interface
    E2E_BROWSER_CHANNEL=chrome npx playwright test --project=interface

The repository caches only the Linux Chromium build; nothing here downloads
another browser. The `interface` visual baselines were captured on Linux
Chromium, so a different engine may show honest rendering differences.
Review them before you accept new snapshots.

No on-device iPhone harness is committed. Validate the iPhone by hand
against the deployed origin: install the PWA, then walk the section 12
acceptance items for touch, safe areas, the keyboard, back navigation, and
compact density. Record the device, iOS version, and Safari version as a
row above, the same as an automated run.
