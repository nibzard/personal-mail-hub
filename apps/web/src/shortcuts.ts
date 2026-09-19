import { useSyncExternalStore } from "react";

/*
 * The single-key shortcut preference (SPEC F10 and F11): one switch that turns
 * the j/k/o-class shortcuts off, leaving modifier chords like the palette
 * shortcut working. The choice is stored under "mailhub.singleKeyShortcuts",
 * mirroring the theme store; the settings screen adopts it when it ships.
 */

const STORAGE_KEY = "mailhub.singleKeyShortcuts";

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

let enabled = readStored();
const listeners = new Set<() => void>();

/** Applies and persists the preference. */
export function setSingleKeyShortcuts(on: boolean): void {
  enabled = on;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Storage can be unavailable in private browsing; the choice still
    // applies for this session.
  }
  for (const listener of listeners) {
    listener();
  }
}

/** True when single-key shortcuts respond. */
export function getSingleKeyShortcuts(): boolean {
  return enabled;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The single-key shortcut preference as reactive state. */
export function useSingleKeyShortcuts(): boolean {
  return useSyncExternalStore(subscribe, getSingleKeyShortcuts);
}
