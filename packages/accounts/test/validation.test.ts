import { describe, expect, it } from "vitest";
import { AccountError } from "../src/errors.ts";
import {
  folderKey,
  normalizeDiscoveredFolders,
  normalizeEmailAddress,
  normalizeIdentities,
} from "../src/validation.ts";

/** Pure input validation (SPEC F1): identity addresses and names, discovery runs. */

/** Assert one call rejects with an invalid_request account error. */
function expectInvalid(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AccountError);
    expect((error as AccountError).code).toBe("invalid_request");
    return;
  }
  throw new Error("The call was expected to reject, but it resolved.");
}

describe("normalizeEmailAddress", () => {
  it("trims, lowercases, and accepts dot-separated atoms", () => {
    expect(normalizeEmailAddress("  First.Last+Tag@EXAMPLE.com ")).toBe("first.last+tag@example.com");
    expect(normalizeEmailAddress("a!#$%&'*+/=?^_`{|}~@example.com")).toBe(
      "a!#$%&'*+/=?^_`{|}~@example.com",
    );
  });

  it("rejects local parts with leading, trailing, or doubled dots", () => {
    expectInvalid(() => normalizeEmailAddress("..@example.com"));
    expectInvalid(() => normalizeEmailAddress("a..b@example.com"));
    expectInvalid(() => normalizeEmailAddress(".foo@example.com"));
    expectInvalid(() => normalizeEmailAddress("foo.@example.com"));
  });

  it("rejects local parts over 64 characters and malformed domains", () => {
    expectInvalid(() => normalizeEmailAddress(`${"a".repeat(65)}@example.com`));
    expect(normalizeEmailAddress(`${"a".repeat(64)}@example.com`)).toBe(`${"a".repeat(64)}@example.com`);
    expectInvalid(() => normalizeEmailAddress("user@"));
    expectInvalid(() => normalizeEmailAddress("user@-example.com"));
  });
});

describe("normalizeIdentities", () => {
  it("trims names and treats blank ones as absent", () => {
    expect(
      normalizeIdentities([
        { address: "user@example.com", name: "  Main User  ", isDefault: true },
        { address: "alias@example.com", name: "   ", isDefault: false },
      ]),
    ).toEqual([
      { address: "user@example.com", name: "Main User", isDefault: true },
      { address: "alias@example.com", name: null, isDefault: false },
    ]);
  });

  it("rejects control characters in display names", () => {
    // A control would seal into the outbound From header as a Q-encoded =00
    // or =1B, which strict receiving MTAs reject.
    expectInvalid(() =>
      normalizeIdentities([{ address: "user@example.com", name: "Bad\u0000Name", isDefault: true }]),
    );
    expectInvalid(() =>
      normalizeIdentities([{ address: "user@example.com", name: "Esc\u001bape", isDefault: true }]),
    );
    expectInvalid(() =>
      normalizeIdentities([{ address: "user@example.com", name: "Del\u007fete", isDefault: true }]),
    );
  });

  it("rejects a display name over 128 characters", () => {
    expectInvalid(() =>
      normalizeIdentities([{ address: "user@example.com", name: "n".repeat(129), isDefault: true }]),
    );
  });
});

describe("normalizeDiscoveredFolders", () => {
  it("keys every inbox spelling as one folder and other names by case", () => {
    expect(folderKey("INBOX")).toBe(folderKey("inbox"));
    expect(folderKey("Inbox")).toBe(folderKey("inbox"));
    expect(folderKey("Sent")).not.toBe(folderKey("sent"));
    expect(folderKey("INBOX/Sent")).toBe("INBOX/Sent");
  });

  it("rejects two spellings of the reserved inbox in one run", () => {
    expectInvalid(() => normalizeDiscoveredFolders([{ name: "INBOX" }, { name: "Inbox" }]));
  });

  it("keeps case-distinct names apart outside the reserved inbox", () => {
    const folders = normalizeDiscoveredFolders([{ name: "Sent" }, { name: "sent" }]);
    expect(folders.map((folder) => folder.name)).toEqual(["Sent", "sent"]);
  });

  it("grants the inbox role to any spelling of the reserved name", () => {
    expect(normalizeDiscoveredFolders([{ name: "Inbox" }])[0]!.roles).toEqual(["inbox"]);
  });
});
