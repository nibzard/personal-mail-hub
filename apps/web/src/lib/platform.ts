/*
 * Platform detection for keyboard labels (SPEC F12): native Mac shortcut
 * symbols, including `⌘K`, on Apple platforms; `Ctrl` plus the key elsewhere.
 */

/** The two keyboard conventions the interface labels shortcuts for. */
export type ShortcutPlatform = "apple" | "other";

/** True when the platform is macOS, iOS, iPadOS, or visionOS. */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const hints = navigator as Navigator & {
    userAgentData?: { platform?: string; platforms?: string[] };
  };
  const sources = [
    navigator.platform,
    hints.userAgentData?.platform ?? "",
    (hints.userAgentData?.platforms ?? []).join(" "),
    navigator.userAgent,
  ];
  return sources.some((source) => /mac|iphone|ipad|ipod/i.test(source));
}

/** The platform shortcut labels are formatted for. */
export function shortcutPlatform(): ShortcutPlatform {
  return isApplePlatform() ? "apple" : "other";
}

/**
 * The palette chord, split into one label per key so each part renders as
 * its own `Kbd`. `⌘` is the native symbol on Apple platforms.
 */
export function paletteShortcutKeys(platform: ShortcutPlatform): string[] {
  return platform === "apple" ? ["⌘", "K"] : ["Ctrl", "K"];
}

/**
 * True when the event is the palette chord on its platform (SPEC F11).
 * `Cmd+P` and `Ctrl+P` stay reserved for printing and never match, and the
 * chord works while an input or the editor holds focus.
 */
export function isPaletteShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "key">,
  platform: ShortcutPlatform,
): boolean {
  const primary = platform === "apple" ? event.metaKey : event.ctrlKey;
  return primary && !event.altKey && (event.key === "k" || event.key === "K");
}
