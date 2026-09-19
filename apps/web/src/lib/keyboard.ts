/*
 * Shortcut scope rules (SPEC F11): single-key shortcuts stay inactive while
 * text is being entered, while a dialog or menu is open, and while composition
 * is in progress. Key repeats never trigger a mutation twice.
 */

/** Elements whose keys belong to the text they hold, not to the shell. */
function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) {
    return true;
  }
  // Overlays that swallow single keys: dialogs, menus, and listbox popups.
  return target.closest("[role='dialog'], [role='menu'], [role='listbox']") !== null;
}

/**
 * True when a single-key shortcut may run for this event. `mutation` commands
 * (archive, star, read state) additionally ignore held-down key repeats; pure
 * navigation keeps responding while the key is held.
 */
export function shouldRunSingleKey(
  event: Pick<KeyboardEvent, "target" | "isComposing" | "repeat">,
  options: { mutation: boolean },
): boolean {
  if (event.isComposing) {
    return false;
  }
  if (options.mutation && event.repeat) {
    return false;
  }
  return !ownsKeys(event.target);
}
