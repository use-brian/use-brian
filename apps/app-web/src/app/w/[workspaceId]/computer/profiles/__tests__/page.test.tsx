/**
 * [COMP:app-web/profile-management] Dedicated Browser profiles route.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/computer/browser-profiles-section", () => ({
  BrowserProfilesSection: ({
    selectedProfileId,
    creating,
  }: {
    selectedProfileId?: string;
    creating?: boolean;
  }) => <div>{creating ? "New profile" : `Profile ${selectedProfileId ?? "default"}`}</div>,
}));

import BrowserProfilesPage from "../page";

describe("[COMP:app-web/profile-management] Browser profiles route", () => {
  it("owns query-addressed profile management outside the live-browser index", async () => {
    const page = await BrowserProfilesPage({
      searchParams: Promise.resolve({ profile: "profile-1" }),
    });
    const html = renderToStaticMarkup(page);
    expect(html).toContain("Profile profile-1");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("lg:px-5");
    expect(html).not.toContain("max-w-3xl");
  });

  it("passes the compact create state through", async () => {
    const page = await BrowserProfilesPage({
      searchParams: Promise.resolve({ new: "1" }),
    });
    expect(renderToStaticMarkup(page)).toContain("New profile");
  });
});
