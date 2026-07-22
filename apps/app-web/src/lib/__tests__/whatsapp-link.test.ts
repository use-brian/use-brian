import { describe, it, expect } from "vitest";
import { buildWhatsappDeepLink } from "../whatsapp-link";

describe("[COMP:app-web/whatsapp-link] WhatsApp link helpers", () => {
  it("builds a wa.me deep link with the code prefilled", () => {
    expect(buildWhatsappDeepLink("+85261234567", "WA1234")).toBe(
      "https://wa.me/85261234567?text=WA1234",
    );
  });

  it("strips display formatting from the operator's number", () => {
    // The env fallback is operator display text and may carry spacing/punctuation;
    // wa.me accepts digits only.
    expect(buildWhatsappDeepLink("+1 (555) 010-0200", "ABC123")).toBe(
      "https://wa.me/15550100200?text=ABC123",
    );
  });

  it("returns null when the number has no digits", () => {
    expect(buildWhatsappDeepLink("not-a-number", "ABC123")).toBeNull();
    expect(buildWhatsappDeepLink("", "ABC123")).toBeNull();
    expect(buildWhatsappDeepLink(null, "ABC123")).toBeNull();
    expect(buildWhatsappDeepLink(undefined, "ABC123")).toBeNull();
  });

  it("returns null for a malformed code rather than a broken link", () => {
    expect(buildWhatsappDeepLink("+85261234567", "abc")).toBeNull();
    expect(buildWhatsappDeepLink("+85261234567", "TOOLONG7")).toBeNull();
    expect(buildWhatsappDeepLink("+85261234567", "")).toBeNull();
    // Lowercase is not the minted charset — the bot upper-cases on receipt,
    // but a link should carry exactly what was minted.
    expect(buildWhatsappDeepLink("+85261234567", "wa1234")).toBeNull();
  });
});
