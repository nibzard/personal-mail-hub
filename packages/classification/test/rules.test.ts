import { describe, expect, it } from "vitest";
import { matchDeterministicRules } from "../src/index.ts";

/**
 * Deterministic-rule acceptance (SPEC F8): 2FA codes, bank-style documents,
 * and delivery failures answer locally; unmatched mail falls through to Jev.
 */

describe("deterministic rules", () => {
  it("classifies an access-code subject as a security alert", () => {
    expect(matchDeterministicRules({ senderAddress: "noreply@shop.example", subject: "Your verification code is 4821" }))
      .toMatchObject({ classHint: "security_alert" });
    expect(matchDeterministicRules({ senderAddress: null, subject: "Sign-in code: 993 231" }))
      .toMatchObject({ classHint: "security_alert" });
  });

  it("classifies a known security sender as a security alert", () => {
    expect(matchDeterministicRules({ senderAddress: "noreply@github.com", subject: "Anything at all" }))
      .toMatchObject({ classHint: "security_alert", rule: "security_sender_or_subject" });
  });

  it("classifies mailer-daemon mail as a bounce", () => {
    expect(matchDeterministicRules({ senderAddress: "mailer-daemon@mx.example", subject: "Undeliverable" }))
      .toMatchObject({ classHint: "bounce" });
    expect(matchDeterministicRules({ senderAddress: "bot@mx.example", subject: "Delivery Status Notification (Delay)" }))
      .toMatchObject({ classHint: "bounce" });
  });

  it("matches sender addresses regardless of the case the server sent", () => {
    expect(matchDeterministicRules({ senderAddress: "MAILER-DAEMON@MX.Example", subject: null }))
      .toMatchObject({ classHint: "bounce" });
    expect(matchDeterministicRules({ senderAddress: "noreply@GitHub.com", subject: null }))
      .toMatchObject({ classHint: "security_alert" });
  });

  it("classifies statement and invoice subjects as receipts", () => {
    expect(matchDeterministicRules({ senderAddress: "statements@bank.example", subject: "Your September statement" }))
      .toMatchObject({ classHint: "receipt" });
  });

  it("answers nothing for ordinary correspondence", () => {
    expect(matchDeterministicRules({ senderAddress: "friend@example.com", subject: "Dinner on Saturday" })).toBeNull();
    expect(matchDeterministicRules({ senderAddress: null, subject: null })).toBeNull();
  });
});
