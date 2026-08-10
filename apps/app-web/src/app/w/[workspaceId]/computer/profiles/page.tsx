"use client";

/**
 * Browser profiles mode for the Browsers operator surface.
 *
 * Kept on its own static route so the operator top bar can switch cleanly
 * between the live-browser canvas and profile management.
 *
 * [COMP:app-web/profile-management]
 */

import { BrowserProfilesSection } from "@/components/computer/browser-profiles-section";

export default function BrowserProfilesPage() {
  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        <BrowserProfilesSection />
      </div>
    </div>
  );
}
