import { describe, expect, it } from "vitest";
import {
  equalState,
  parseOidcTransaction,
  serializeOidcTransaction,
  type OidcTransaction,
} from "./oidc-transaction";

const SECRET = "s".repeat(32);
const TX: OidcTransaction = {
  state: "a".repeat(43),
  nonce: "b".repeat(43),
  verifier: "c".repeat(64),
  createdAt: 1_000_000,
  next: "https://app.example.test/w/one",
};

describe("[COMP:app/outpost-auth] OIDC transaction", () => {
  it("round-trips signed short-lived state", () => {
    expect(parseOidcTransaction(serializeOidcTransaction(TX, SECRET), SECRET, 1_100_000)).toEqual(TX);
  });

  it("rejects tampering, expiry, and mismatched state", () => {
    const value = serializeOidcTransaction(TX, SECRET);
    expect(parseOidcTransaction(`${value}x`, SECRET, 1_100_000)).toBeNull();
    expect(parseOidcTransaction(value, SECRET, 1_700_001)).toBeNull();
    expect(equalState(TX.state, `${TX.state}x`)).toBe(false);
  });
});
