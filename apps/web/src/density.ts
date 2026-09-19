import { useSyncExternalStore } from "react";

/*
 * Reading density (SPEC F10 and F12): compact is the default and comfortable
 * remains available. The choice paints through the `data-density` attribute,
 * which the density tokens in styles.css read; compact rows keep their text
 * size and touch targets. The last choice stays in local storage so the
 * first paint already matches, while the server settings remain the record.
 */

export type Density = "compact" | "comfortable";

const STORAGE_KEY = "mailhub.density";

function isDensity(value: unknown): value is Density {
  return value === "compact" || value === "comfortable";
}

function readStoredDensity(): Density {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isDensity(value) ? value : "compact";
  } catch {
    return "compact";
  }
}

function syncAttribute(density: Density) {
  if (density === "comfortable") {
    document.documentElement.setAttribute("data-density", "comfortable");
  } else {
    document.documentElement.removeAttribute("data-density");
  }
}

let currentDensity: Density = readStoredDensity();
const listeners = new Set<() => void>();

syncAttribute(currentDensity);

/** Applies and persists a density choice. */
export function setDensity(density: Density) {
  currentDensity = density;
  try {
    window.localStorage.setItem(STORAGE_KEY, density);
  } catch {
    // Storage can be unavailable in private browsing; the choice still
    // applies for this session.
  }
  syncAttribute(density);
  for (const listener of listeners) {
    listener();
  }
}

/** The chosen density. */
export function getDensity(): Density {
  return currentDensity;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The density preference as reactive state. */
export function useDensity(): Density {
  return useSyncExternalStore(subscribe, getDensity);
}
