import { describe, it, expect } from "vitest";
import { selectActiveUser, getInitials } from "@/lib/user";

/**
 * Build a JWT-shaped access token whose payload carries `sub` + `exp`. Only the
 * middle segment is read (`split('.')[1]`); the signature is a stub. Standard
 * padded base64 keeps `atob` happy in the node test env (the `-`/`_` → `+`/`/`
 * normalization in the impl is a no-op on it).
 */
function accessToken(sub: string, exp: number): string {
  const payload = Buffer.from(JSON.stringify({ sub, exp, type: "access" })).toString(
    "base64",
  );
  return `header.${payload}.sig`;
}

function userCookie(u: { id?: string; name: string; email: string }): string {
  return encodeURIComponent(JSON.stringify(u));
}

const NOW = 1_781_000_000; // fixed epoch seconds → deterministic exps
const gmail = { id: "gmail-id", name: "Gmail Hinson", email: "hinson.sub@gmail.com" };
const delta = { id: "delta-id", name: "Hinson Wong", email: "hinson.wong@deltadefi.io" };

describe("[COMP:app-web/user] active-account cookie selection", () => {
  it("returns the only user cookie when there is no twin", () => {
    expect(selectActiveUser(`user=${userCookie(delta)}`)?.email).toBe(delta.email);
  });

  it("returns null when there is no user cookie", () => {
    expect(selectActiveUser("locale=en; foo=bar")).toBeNull();
  });

  it("parses a single double-encoded user cookie value", () => {
    // A re-encoded twin can arrive percent-encoded twice; the reader must still
    // decode it rather than dropping it.
    const twice = encodeURIComponent(userCookie(delta));
    expect(selectActiveUser(`user=${twice}`)?.email).toBe(delta.email);
  });

  it("picks the user matching the freshest access_token sub, NOT the positional last", () => {
    // The regression: after a cross-origin switch the live `.sidan.ai` cookie
    // (delta, just switched TO) can sort FIRST while the stale host-only twin
    // (gmail) sorts LAST. The old positional read returned gmail and pinned the
    // switcher to the account the user just left. We must return delta.
    const cookie = [
      `user=${userCookie(delta)}`,
      `access_token=${accessToken(delta.id, NOW + 3600)}`, // fresh — switched-to
      `access_token=${accessToken(gmail.id, NOW - 3600)}`, // stale twin
      `user=${userCookie(gmail)}`,
    ].join("; ");
    expect(selectActiveUser(cookie)?.id).toBe(delta.id);
    expect(selectActiveUser(cookie)?.email).toBe(delta.email);
  });

  it("resolves the twin even after the 1h access_token twin has expired away (single token)", () => {
    // The `user` twin lives 30d but the `access_token` twin is only 1h, so the
    // common steady state is two `user` cookies but a single live access_token.
    // Its `sub` still disambiguates, with the stale gmail twin sorting LAST.
    const cookie = [
      `user=${userCookie(delta)}`,
      `access_token=${accessToken(delta.id, NOW + 3600)}`,
      `user=${userCookie(gmail)}`,
    ].join("; ");
    expect(selectActiveUser(cookie)?.id).toBe(delta.id);
  });

  it("falls back to positional last when no access_token is present", () => {
    const cookie = `user=${userCookie(delta)}; user=${userCookie(gmail)}`;
    expect(selectActiveUser(cookie)?.id).toBe(gmail.id);
  });

  it("falls back to positional last when the freshest token's sub matches no candidate", () => {
    const cookie = [
      `user=${userCookie(delta)}`,
      `user=${userCookie(gmail)}`,
      `access_token=${accessToken("third-party-id", NOW + 3600)}`,
    ].join("; ");
    expect(selectActiveUser(cookie)?.id).toBe(gmail.id);
  });

  it("tolerates a legacy id-less user cookie among twins (no match → last wins)", () => {
    const legacy = { name: "Legacy", email: "legacy@x.com" }; // predates the id field
    const cookie = [
      `user=${userCookie(legacy)}`,
      `user=${userCookie(gmail)}`,
      `access_token=${accessToken(delta.id, NOW + 3600)}`, // sub matches neither
    ].join("; ");
    expect(selectActiveUser(cookie)?.email).toBe(gmail.email);
  });
});

describe("[COMP:app-web/user] getInitials", () => {
  it("derives an initial from an email local part", () => {
    expect(getInitials("hinson.wong@deltadefi.io")).toBe("H");
  });
  it("falls back to ? for empty input", () => {
    expect(getInitials("")).toBe("?");
  });
});
