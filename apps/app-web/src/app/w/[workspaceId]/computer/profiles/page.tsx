/**
 * Browser profiles mode for the Browsers operator surface.
 *
 * Kept on its own static route so the operator top bar can switch cleanly
 * between the live-browser canvas and profile management.
 *
 * [COMP:app-web/profile-management]
 */

import { BrowserProfilesSection } from "@/components/computer/browser-profiles-section";

export default async function BrowserProfilesPage({
  searchParams,
}: {
  searchParams: Promise<{ profile?: string | string[]; new?: string | string[] }>;
}) {
  const query = await searchParams;
  const selectedProfileId =
    typeof query.profile === "string" ? query.profile : undefined;
  const creating = query.new === "1";

  return (
    <div className="h-full overflow-y-auto px-3 py-4 sm:px-4 sm:py-5 lg:px-5">
      <BrowserProfilesSection
        selectedProfileId={selectedProfileId}
        creating={creating}
      />
    </div>
  );
}
