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
import { profileSurfaces } from "../browser-profiles-section";

function profile(overrides: Partial<BrowserProfile> = {}): BrowserProfile {
  return {
    id: "p1",
    workspaceId: "ws-1",
    ownerUserId: "u1",
    name: "IG",
    clearance: "confidential",
    enabledAssistantIds: [],
    defaultBackend: "cloud",
    proxyUrl: null,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    sessions: [],
    grants: [],
    ...overrides,
  };
}

describe("[COMP:app-web/profile-management] Profile surfaces by backend", () => {
  it("offers the vault surface on a cloud profile (the vault is what holds its logins)", () => {
    expect(profileSurfaces(profile({ defaultBackend: "cloud" }))).toEqual({
      signIn: true,
      vaultSessions: true,
      ownBrowserNote: false,
    });
  });

  it("replaces the vault surface with the own-browser note on a My Browser profile", () => {
    expect(profileSurfaces(profile({ defaultBackend: "local" }))).toEqual({
      signIn: false,
      vaultSessions: false,
      ownBrowserNote: true,
    });
  });
});
