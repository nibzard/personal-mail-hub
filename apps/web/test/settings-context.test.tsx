// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, SettingsResponse, SettingsUpdateBody } from "@mail-hub/contracts";

/*
 * The settings provider's save ordering (SPEC F10 and F12): two rapid saves
 * of one key can settle out of order, and a late answer for the older patch
 * must not repaint its value over the newer edit.
 */

const harness = vi.hoisted(() => ({
  stored: null as AppSettings | null,
  puts: [] as Array<{
    patch: SettingsUpdateBody;
    settle: (settings: AppSettings) => void;
  }>,
}));

// jsdom ships no matchMedia; the theme module the provider pulls in reads it
// at module scope, so the stub must exist before that import evaluates.
vi.hoisted(() => {
  window.matchMedia =
    window.matchMedia ??
    ((query: string) => ({
      media: query,
      matches: false,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }));
});

vi.mock("../src/lib/api.ts", () => ({
  apiGet: async () => ({ settings: harness.stored }),
  apiPut: (_path: string, patch: SettingsUpdateBody) =>
    new Promise<SettingsResponse>((resolve) => {
      harness.puts.push({
        patch,
        settle: (settings) => resolve({ settings }),
      });
    }),
  toApiError: () => {
    throw new Error("unused in this suite");
  },
  ApiError: class extends Error {},
}));

import {
  SettingsProvider,
  useAppSettings,
  type SettingsState,
} from "../src/settings/settings-context.tsx";
import {
  readCachedHomeStartup,
  STORAGE_KEY as HOME_STARTUP_KEY,
} from "../src/settings/home-startup.ts";

const BASE: AppSettings = {
  theme: "system",
  density: "compact",
  singleKeyShortcuts: true,
  cleanViewDefault: false,
  classificationEnabled: false,
  homeEnabled: true,
  classificationMonthlyCostCapUsd: null,
  backfillClassification: false,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let state: { current: SettingsState | null };

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root !== null) {
    act(() => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  harness.stored = null;
  harness.puts.length = 0;
});

/** Mounts the provider with one probe that records the state it renders. */
async function mountProvider(stored: AppSettings = { ...BASE }): Promise<void> {
  state = { current: null };
  function Probe() {
    state.current = useAppSettings();
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  harness.stored = stored;
  await act(async () => {
    root!.render(
      <SettingsProvider recoveryGeneration="gen-1">
        <Probe />
      </SettingsProvider>,
    );
  });
  expect(state.current?.phase).toBe("ready");
}

describe("the settings provider's save ordering", () => {
  it("keeps the newer edit when an older answer for the same key lands late", async () => {
    await mountProvider();

    // Two rapid saves of one key; the server settles them out of order.
    act(() => {
      state.current!.update({ theme: "dark" });
      state.current!.update({ theme: "light" });
    });
    expect(harness.puts).toHaveLength(2);
    expect(state.current!.settings.theme).toBe("light");

    await act(async () => {
      harness.puts[1]!.settle({ ...BASE, theme: "light" });
    });
    expect(state.current!.settings.theme).toBe("light");

    // The older patch answers last, with its own stored value: the newer
    // edit keeps the screen.
    await act(async () => {
      harness.puts[0]!.settle({ ...BASE, theme: "dark" });
    });
    expect(state.current!.settings.theme).toBe("light");
    expect(state.current!.savePhase).toBe("saved");
  });

  it("still adopts the stored echo of a key no newer edit touched", async () => {
    await mountProvider();

    act(() => {
      state.current!.update({ density: "comfortable" });
    });
    expect(harness.puts).toHaveLength(1);
    await act(async () => {
      harness.puts[0]!.settle({ ...BASE, density: "comfortable" });
    });
    expect(state.current!.settings.density).toBe("comfortable");
    expect(state.current!.savePhase).toBe("saved");
  });
});

describe("the startup view cache", () => {
  beforeEach(() => {
    window.localStorage.removeItem(HOME_STARTUP_KEY);
  });

  it("records the stored choice after a confirmed read", async () => {
    await mountProvider({ ...BASE, homeEnabled: false });
    expect(readCachedHomeStartup()).toBe(false);
  });

  it("records the choice a confirmed save answered with", async () => {
    await mountProvider();
    expect(readCachedHomeStartup()).toBe(true);

    act(() => {
      state.current!.update({ homeEnabled: false });
    });
    await act(async () => {
      harness.puts[0]!.settle({ ...BASE, homeEnabled: false });
    });
    expect(readCachedHomeStartup()).toBe(false);
  });

  it("keeps the newer choice when an older answer lands late", async () => {
    await mountProvider();

    // Turn Home off, then back on; the answers settle out of order.
    act(() => {
      state.current!.update({ homeEnabled: false });
      state.current!.update({ homeEnabled: true });
    });
    await act(async () => {
      harness.puts[1]!.settle({ ...BASE, homeEnabled: true });
    });
    await act(async () => {
      harness.puts[0]!.settle({ ...BASE, homeEnabled: false });
    });
    expect(state.current!.settings.homeEnabled).toBe(true);
    expect(readCachedHomeStartup()).toBe(true);
  });
});
