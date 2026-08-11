/**
 * [COMP:app-web/profile-management] Dedicated Browser profiles route.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/computer/browser-profiles-section", () => ({
  BrowserProfilesSection: () => <div>Profile management</div>,
}));

import BrowserProfilesPage from "../page";

describe("[COMP:app-web/profile-management] Browser profiles route", () => {
  it("owns profile management outside the live-browser index", () => {
    const html = renderToStaticMarkup(<BrowserProfilesPage />);
    expect(html).toContain("Profile management");
    expect(html).toContain("overflow-y-auto");
  });
});
