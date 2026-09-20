// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  phase: "loading" as "loading" | "ready" | "error",
  settings: { homeEnabled: true }, reload: vi.fn(),
}));
vi.mock("../src/settings/settings-context.tsx", () => ({ useAppSettings: () => harness }));
import { HomeStartupGate } from "../src/settings/home-startup-gate";
import { STORAGE_KEY } from "../src/settings/home-startup";

let root: Root | null = null;
let container: HTMLDivElement;
const paints: boolean[] = [];
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  window.localStorage.clear();
  harness.phase = "loading";
  harness.settings = {homeEnabled: true};
  paints.length = 0;
});
async function render() {
  if (root === null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(<HomeStartupGate>{(home) => {
      paints.push(home);
      return <p>{home ? "Home content" : "Inbox content"}</p>;
    }}</HomeStartupGate>);
  });
}

describe("Home startup", () => {
  it("waits for the server choice on a fresh device without painting Home first", async () => {
    await render();
    expect(paints).toEqual([]);
    harness.settings.homeEnabled = false;
    harness.phase = "ready";
    await render();
    expect(paints).toEqual([false]);
  });

  it("uses the server over stale cache and keeps the active view after settings change", async () => {
    window.localStorage.setItem(STORAGE_KEY, "true");
    await render();
    harness.settings.homeEnabled = false;
    harness.phase = "ready";
    await render();
    harness.settings.homeEnabled = true;
    await render();
    expect(paints.every(home => home === false)).toBe(true);
  });

  it("uses the last confirmed setting when offline", async () => {
    window.localStorage.setItem(STORAGE_KEY, "false");
    harness.phase = "error";
    await render();
    expect(container.textContent).toBe("Inbox content");
  });

  it("offers retry and Inbox when settings fail without a cache", async () => {
    harness.phase = "error";
    await render();
    expect(container.textContent).toContain("Startup settings cannot be loaded");
    expect(container.textContent).toContain("Try again");
    await act(async () => (Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Open Inbox")!).click());
    expect(container.textContent).toBe("Inbox content");
    harness.phase = "ready";
    await render();
    expect(container.textContent).toBe("Inbox content");
  });
});
