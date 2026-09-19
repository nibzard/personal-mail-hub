import { useSyncExternalStore } from "react";

/*
 * Theme choice: system, light, or dark, per SPEC.md F10. The choice is
 * stored under "mailhub.theme". The inline script in index.html applies the
 * class before first paint so the initial theme never flashes.
 */

export type Theme = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "mailhub.theme";
const DARK_MEDIA = "(prefers-color-scheme: dark)";

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

function readStoredTheme(): Theme {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : "system";
  } catch {
    return "system";
  }
}

const darkMedia = window.matchMedia(DARK_MEDIA);

function syncClass(theme: Theme) {
  const dark =
    theme === "dark" || (theme === "system" && darkMedia.matches);
  document.documentElement.classList.toggle("dark", dark);
}

let currentTheme: Theme = readStoredTheme();
const listeners = new Set<() => void>();

syncClass(currentTheme);

darkMedia.addEventListener("change", () => {
  if (currentTheme === "system") {
    syncClass(currentTheme);
    for (const listener of listeners) {
      listener();
    }
  }
});

/** Applies and persists a theme choice. */
export function setTheme(theme: Theme) {
  currentTheme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable in private browsing; the choice still
    // applies for this session.
  }
  syncClass(theme);
  for (const listener of listeners) {
    listener();
  }
}

/** The chosen theme, before resolving "system". */
export function getTheme(): Theme {
  return currentTheme;
}

/** The theme currently painted. */
export function getResolvedTheme(): ResolvedTheme {
  return document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTheme(): {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
} {
  const theme = useSyncExternalStore(subscribe, getTheme);
  const resolvedTheme = useSyncExternalStore(subscribe, getResolvedTheme);
  return { theme, resolvedTheme, setTheme };
}
