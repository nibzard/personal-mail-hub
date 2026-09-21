import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_EDGE_PARTS,
  attachmentEdgeMetadata,
  base64NulBody,
  foldedReferencesParent,
  foldedReferencesReply,
  malformedHeaderLines,
  malformedMailBytes,
  missingHeader,
  nestedAddressMetadata,
  nulAddressNeighbor,
  nulEverywhere,
  nulParent,
  plainValidNeighbor,
  validUnicodeNeighbor,
  type MalformedMail,
} from "../src/index.ts";

/**
 * Corpus invariants (T109): every fixture is deterministic, carries the
 * malformation it claims, contains nothing private, parses without a crash,
 * and survives the encode/decode round trip every string-based transport in
 * the stack performs. A fixture that silently loses its defect is vacuous,
 * so presence is pinned here, not only in the boundary tests.
 */

const NUL = String.fromCharCode(0);

/** Every corpus fixture, named for the invariant messages below. */
function corpus(): Record<string, () => MalformedMail> {
  return {
    nulEverywhere,
    nulParent,
    nulAddressNeighbor,
    base64NulBody,
    missingFrom: () => missingHeader("from"),
    missingSubject: () => missingHeader("subject"),
    missingMessageId: () => missingHeader("message-id"),
    missingDate: () => missingHeader("date"),
    missingTo: () => missingHeader("to"),
    malformedHeaderLines,
    foldedReferencesReply,
    foldedReferencesParent,
    nestedAddressMetadata,
    attachmentEdgeMetadata,
    validUnicodeNeighbor,
    plainValidNeighbor,
  };
}

describe("malformed-mail corpus", () => {
  it("builds identical strings on every call", () => {
    for (const build of Object.values(corpus())) {
      expect(build()).toEqual(build());
    }
  });

  it("round-trips every fixture through bytes", () => {
    // The fake mailbox joins strings and encodes them; the harness servers
    // and the parser consume bytes. A fixture that cannot survive the round
    // trip changes shape between boundaries, so tests would not pin it.
    for (const build of Object.values(corpus())) {
      const mail = build();
      const decoded = new TextDecoder().decode(malformedMailBytes(mail));
      expect(decoded).toBe(`${mail.headers}\r\n\r\n${mail.body}`);
    }
  });

  it("carries a raw NUL exactly where the incident fixtures claim one", () => {
    for (const build of [nulEverywhere, nulParent]) {
      const mail = build();
      expect(mail.headers).toContain(NUL);
    }
    // Every other fixture must be NUL-free in headers and body alike: a
    // stray NUL in a "valid" or unrelated fixture would turn its boundary
    // assertions into accidents. The check walks the whole corpus, so a
    // fixture added later joins it without an edit here.
    for (const [name, build] of Object.entries(corpus())) {
      if (name === "nulEverywhere" || name === "nulParent") {
        continue;
      }
      const mail = build();
      expect(`${mail.headers}\r\n\r\n${mail.body}`).not.toContain(NUL);
    }
    // The decoded-NUL fixtures hide the byte in an encoding, not the string.
    expect(nulEverywhere().headers).toContain("=00");
    expect(nulAddressNeighbor().headers).toContain("=00");
    expect(base64NulBody().body).toBe("eAB5");
  });

  it("omits exactly the named header from each missing-header fixture", () => {
    const cases: Array<[string, () => MalformedMail]> = [
      ["From:", () => missingHeader("from")],
      ["Subject:", () => missingHeader("subject")],
      ["Message-ID:", () => missingHeader("message-id")],
      ["Date:", () => missingHeader("date")],
      ["To:", () => missingHeader("to")],
    ];
    for (const [field, build] of cases) {
      const lines = build().headers.split("\r\n");
      expect(lines.some((line) => line.startsWith(field))).toBe(false);
      // The four headers the fixture did not drop are still there.
      const kept = cases.filter(([other]) => other !== field).filter(([other]) =>
        lines.some((line) => line.startsWith(other)),
      );
      expect(kept).toHaveLength(4);
    }
  });

  it("folds the reply references across continuation lines", () => {
    const lines = foldedReferencesReply().headers.split("\r\n");
    expect(lines).toContain("In-Reply-To:");
    expect(lines).toContain("\t<folded-parent@example.com>");
    expect(lines).toContain("References: <folded-root@example.com>");
    expect(lines).toContain(" <folded-mid@example.com>");
    expect(lines).toContain(" <folded-parent@example.com>");
  });

  it("states the attachment edge shapes it claims", () => {
    const body = attachmentEdgeMetadata().body;
    expect(body).toContain("filename*=utf-8''n%C3%A4hme.txt");
    expect(body).toContain("filename*0=continued-;");
    expect(body).toContain("filename*1=name.bin");
    // Five parts: one per known decoded marker plus the empty one.
    expect(ATTACHMENT_EDGE_PARTS).toHaveLength(5);
    expect(ATTACHMENT_EDGE_PARTS[3]!.marker).toBe("");
  });

  it("parses every fixture without throwing", async () => {
    // Malformedness lives at the value level: a fixture that crashed the
    // parser would fail as an outage, not as a contained per-field defect,
    // and the boundary contract is exactly that no defect escalates.
    for (const build of Object.values(corpus())) {
      const parsed = await simpleParser(Buffer.from(malformedMailBytes(build())));
      expect(parsed).toBeDefined();
    }
  });

  it("holds no private facts: only example domains and invented local parts", () => {
    // The reduction rule forbids provider hosts, real addresses, and any
    // value copied from incident logs. Pin the shape the corpus may use.
    for (const build of Object.values(corpus())) {
      const text = `${build().headers}\r\n\r\n${build().body}`;
      for (const token of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? []) {
        expect(token.endsWith("@example.com") || token.endsWith("@example.net")).toBe(true);
      }
    }
  });
});
