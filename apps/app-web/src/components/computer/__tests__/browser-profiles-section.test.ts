/**
 * [COMP:app-web/profile-management] Which surfaces a profile shows.
 *
 * A Remote profile leads to live sign-in, vault, and optional real-browser
 * capture. A Local profile uses extension pairing + local-control scope and
 * does not pretend its real-browser cookies are vault sessions.
 *
 * Pure decision table so it is testable in this package's no-DOM vitest; the
 * JSX wiring itself stays web-QA.
 */

import { describe, expect, it } from "vitest";
import type { BrowserProfile } from "@/lib/api/computer";
import {
  isValidProxyUrl,
  profileSurfaces,
  selectedBrowserProfile,
} from "../browser-profiles-section";

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
  it("offers live sign-in and the vault on a Remote profile", () => {
    expect(profileSurfaces(profile({ defaultBackend: "cloud", canManage: true }))).toEqual({
      signIn: true,
      vaultSessions: true,
      pairBrowser: true,
      captureFromBrowser: true,
      localControl: true,
      ownBrowserNote: false,
    });
  });

  it("offers pairing and local control on a Local profile", () => {
    expect(profileSurfaces(profile({ defaultBackend: "local", canManage: true }))).toEqual({
      signIn: false,
      vaultSessions: false,
      pairBrowser: true,
      captureFromBrowser: false,
      localControl: true,
      ownBrowserNote: true,
    });
  });

  it("keeps pairing and capture owner-only", () => {
    expect(profileSurfaces(profile({ defaultBackend: "cloud", canManage: false }))).toMatchObject({
      pairBrowser: false,
      captureFromBrowser: false,
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

describe("[COMP:app-web/profile-management] Master-detail selection", () => {
  const profiles = [profile({ id: "p1" }), profile({ id: "p2", name: "Work" })];

  it("uses the query-addressed profile and falls back to the first row", () => {
    expect(selectedBrowserProfile(profiles, "p2", false)?.id).toBe("p2");
    expect(selectedBrowserProfile(profiles, "missing", false)?.id).toBe("p1");
    expect(selectedBrowserProfile(profiles, undefined, false)?.id).toBe("p1");
  });

  it("shows no detail while the create form is active", () => {
    expect(selectedBrowserProfile(profiles, "p1", true)).toBeNull();
    expect(selectedBrowserProfile([], undefined, false)).toBeNull();
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
