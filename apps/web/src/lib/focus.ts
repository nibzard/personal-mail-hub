/*
 * Focus restoration (SPEC F11): the dialog itself returns focus to its
 * opener. When that target left the document, focus moves to the nearest
 * surviving message row, then to the list heading, so focus never strands on
 * `body`.
 */

/**
 * Places focus after a dialog closed. Focus the keeps whatever the dialog or
 * the activated command left it on; when nothing took it (the opener is
 * gone), the first surviving fallback receives it.
 */
export function rescueDialogFocus(
  fallbacks: ReadonlyArray<() => HTMLElement | null>,
): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    return;
  }
  for (const fallback of fallbacks) {
    const candidate = fallback();
    if (candidate !== null && candidate.isConnected) {
      candidate.focus();
      return;
    }
  }
}
