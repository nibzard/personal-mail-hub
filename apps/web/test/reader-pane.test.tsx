// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// jsdom ships no matchMedia; the theme module the reader pulls in reads it
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

import { readerStatus } from "../src/components/mail/reader-pane.tsx";

/*
 * The reader's polite region (SPEC F12): what it announces about one
 * message. A plain-text message never runs the frame's inline-image pass,
 * so its status must not wait on an inline map that never arrives.
 */

describe("readerStatus", () => {
  it("ends at Message loaded for a plain-text message with no inline pass", () => {
    // htmlBody false: htmlSanitized is null, so useInlineImages stays null
    // forever and the old status never left its inline-image sentence.
    expect(readerStatus("ready", true, false, null, false)).toBe("Message loaded.");
  });

  it("still announces the inline-image load for an HTML message", () => {
    expect(readerStatus("ready", true, true, null, false)).toBe(
      "Loading the message with its inline images.",
    );
    expect(readerStatus("ready", true, true, new Map(), false)).toBe("Message loaded.");
    expect(readerStatus("ready", true, true, new Map(), true)).toBe(
      "Message loaded in clean view.",
    );
  });

  it("keeps its earlier sentences for loading, error, and header-only rows", () => {
    expect(readerStatus("loading", null, false, null, false)).toBe("Loading the message.");
    expect(readerStatus("error", null, true, null, false)).toBe(
      "The message could not be loaded.",
    );
    expect(readerStatus("ready", false, false, null, false)).toBe(
      "Only the stored header exists for this message so far.",
    );
  });
});
