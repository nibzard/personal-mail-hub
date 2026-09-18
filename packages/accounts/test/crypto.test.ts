import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AccountError } from "../src/errors.ts";
import { createCredentialCipher, parseCredentialsKey } from "../src/crypto.ts";

/** The AES-256-GCM credential cipher (SPEC section 9). */

function key(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

describe("parseCredentialsKey", () => {
  it("accepts 32 bytes in base64", () => {
    const encoded = Buffer.from(randomBytes(32)).toString("base64");
    expect(parseCredentialsKey(encoded)).toEqual(new Uint8Array(Buffer.from(encoded, "base64")));
  });

  it("accepts 32 bytes in base64url", () => {
    const encoded = Buffer.from(randomBytes(32)).toString("base64url");
    expect(parseCredentialsKey(encoded)?.length).toBe(32);
  });

  it("accepts 32 bytes in hex", () => {
    const encoded = Buffer.from(randomBytes(32)).toString("hex");
    expect(parseCredentialsKey(encoded)?.length).toBe(32);
  });

  it("rejects missing, empty, and padded values", () => {
    expect(parseCredentialsKey(undefined)).toBeNull();
    expect(parseCredentialsKey(null)).toBeNull();
    expect(parseCredentialsKey("")).toBeNull();
    expect(parseCredentialsKey("   ")).toBeNull();
  });

  it("rejects keys of the wrong length or alphabet", () => {
    expect(parseCredentialsKey(Buffer.from(randomBytes(16)).toString("base64"))).toBeNull();
    expect(parseCredentialsKey(Buffer.from(randomBytes(33)).toString("base64"))).toBeNull();
    expect(parseCredentialsKey("not-a-key-at-all!!!")).toBeNull();
    expect(parseCredentialsKey("z".repeat(64))).toBeNull();
  });
});

describe("the credential cipher", () => {
  it("seals and opens a password", () => {
    const cipher = createCredentialCipher(key());
    const envelope = cipher.encrypt("hunter2 correction: 6huntr2");
    expect(cipher.decrypt(envelope)).toBe("hunter2 correction: 6huntr2");
  });

  it("marks envelopes with the current version and stores no plaintext", () => {
    const cipher = createCredentialCipher(key());
    const password = "plain-secret-password";
    const envelope = cipher.encrypt(password);
    expect(envelope.startsWith("v1.")).toBe(true);
    expect(envelope).not.toContain(password);
    expect(envelope).not.toContain(Buffer.from(password).toString("base64url"));
  });

  it("draws a fresh initialization vector for every encryption", () => {
    const cipher = createCredentialCipher(key());
    const first = cipher.encrypt("same password");
    const second = cipher.encrypt("same password");
    expect(first).not.toBe(second);
    expect(cipher.decrypt(first)).toBe("same password");
    expect(cipher.decrypt(second)).toBe("same password");
  });

  it("rejects an envelope edited in place", () => {
    const cipher = createCredentialCipher(key());
    const parts = cipher.encrypt("secret").split(".");
    const flipped = parts[3]!.slice(0, -2) + (parts[3]!.endsWith("AA") ? "QQ" : "AA");
    const edited = [parts[0], parts[1], parts[2], flipped].join(".");
    expect(() => cipher.decrypt(edited)).toThrow(AccountError);
  });

  it("rejects an envelope with an edited tag", () => {
    const cipher = createCredentialCipher(key());
    const parts = cipher.encrypt("secret").split(".");
    const resealed = createCredentialCipher(key()).encrypt("other").split(".");
    const spliced = [parts[0], parts[1], resealed[2]!, parts[3]].join(".");
    expect(() => cipher.decrypt(spliced)).toThrow(AccountError);
  });

  it("rejects an envelope opened with a different key", () => {
    const sealer = createCredentialCipher(key());
    const opener = createCredentialCipher(key());
    expect(() => opener.decrypt(sealer.encrypt("secret"))).toThrow(
      expect.objectContaining({ code: "credential_invalid" }),
    );
  });

  it("rejects malformed envelopes without throwing raw crypto errors", () => {
    const cipher = createCredentialCipher(key());
    for (const malformed of ["", "v1", "v1.only", "v2.a.b.c", "v1...", "v1..bb.cc", "not-an-envelope"]) {
      expect(() => cipher.decrypt(malformed)).toThrow(AccountError);
    }
  });
});
