/**
 * [COMP:app-web/profile-management] Which surfaces a profile shows.
 *
 * A profile is only "ONE cookie jar" on the CLOUD backend, where the vault
 * holds its logins. A `local` ("My Browser") profile borrows the logins of the
 * user's real Chrome: nothing is captured, nothing is stored, and the vault is
 * never read. Showing it the vault surface tells the user two false things —
 * that they must sign in through us, and that they have no sites signed in.
 *
 * Pure decision table so it is testable in this package's no-DOM vitest; the
 * JSX wiring itself stays web-QA.
 */

import { describe, expect, it } from "vitest";
import type { BrowserProfile } from "@/lib/api/computer";
import { isValidProxyUrl, profileSurfaces } from "../browser-profiles-section";

function profile(overrides: Partial<BrowserProfile> = {}): BrowserProfile {
  return {
    id: "p1",
    workspaceId: "ws-1",
    ownerUserId: "u1",
    name: "IG",
    clearance: "confidential",
    enabledAssistantIds: [],
    defaultBackend: "cloud",
    localControlMode: "task_tabs",
    proxyUrl: null,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    sessions: [],
    credentials: [],
    grants: [],
    ...overrides,
  };
}

describe("[COMP:app-web/profile-management] Profile surfaces by backend", () => {
  it("offers the vault surface on a cloud profile (the vault is what holds its logins)", () => {
    expect(profileSurfaces(profile({ defaultBackend: "cloud" }))).toEqual({
      signIn: true,
      vaultSessions: true,
      pairBrowser: false,
      localControl: false,
      ownBrowserNote: false,
    });
  });

  it("replaces the vault surface with the own-browser note on a My Browser profile", () => {
    expect(profileSurfaces(profile({ defaultBackend: "local" }))).toEqual({
      signIn: false,
      vaultSessions: false,
      pairBrowser: true,
      localControl: true,
      ownBrowserNote: true,
    });
  });

  it("keeps a proxyUrl the profile carries whichever backend it defaults to", () => {
    expect(profile({ proxyUrl: "http://proxy.example:8080" }).proxyUrl).toBe(
      "http://proxy.example:8080",
    );
    expect(profile({ defaultBackend: "local", proxyUrl: null }).proxyUrl).toBeNull();
  });

  it("keeps the local control scope on the profile independently of its default backend", () => {
    expect(profile().localControlMode).toBe("task_tabs");
    expect(profile({ defaultBackend: "cloud", localControlMode: "full_browser" })).toMatchObject({
      defaultBackend: "cloud",
      localControlMode: "full_browser",
    });
  });
});

/**
 * Proxy URL (D7): the form must refuse a malformed value client-side rather
 * than silently saving something that proxies nothing (story 12).
 */
describe("[COMP:app-web/profile-management] isValidProxyUrl", () => {
  it("accepts an absolute URL with a scheme", () => {
    expect(isValidProxyUrl("http://proxy.example:8080")).toBe(true);
    expect(isValidProxyUrl("http://user:pass@proxy.example:8080")).toBe(true);
    expect(isValidProxyUrl("socks5://proxy.example:1080")).toBe(true);
  });

  it("rejects a bare host or an otherwise malformed value", () => {
    expect(isValidProxyUrl("proxy.example:8080")).toBe(false);
    expect(isValidProxyUrl("not a url")).toBe(false);
    expect(isValidProxyUrl("")).toBe(false);
  });
});
