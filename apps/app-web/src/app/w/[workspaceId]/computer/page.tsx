"use client";

/**
 * Browsers surface index (`/w/[id]/computer`) — the operational home for
 * Browser profiles, encrypted sign-ins, My Browser pairing, and the compact
 * getting-started guide. Live tasks stay reachable from the persistent rail;
 * this index never redirects away from profile management.
 *
 * [COMP:app-web/browsers-surface]
 */

import { MonitorPlay } from "lucide-react";
import { BrowserProfilesSection } from "@/components/computer/browser-profiles-section";
import { BROWSER_EXTENSION_INSTALL_URL } from "@/lib/browser-extension-bridge";
import { useT } from "@/lib/i18n/client";

/** Persistent getting-started copy for the no-live-session state. */
export function BrowsersEmptyState() {
  const t = useT().computer.sessions;

  return (
    <div className="flex flex-col items-center rounded-lg border border-border bg-muted/20 p-5 text-center">
      <MonitorPlay className="size-8 text-muted-foreground/50" aria-hidden />
      <div className="mx-auto mt-3 max-w-lg space-y-1">
        <p className="text-sm font-medium text-foreground">{t.selectTitle}</p>
        <p className="text-xs text-muted-foreground">{t.selectHint}</p>
      </div>
      <div className="mt-4 w-full max-w-sm rounded-lg border border-border bg-muted/30 px-4 py-3">
        <p className="text-xs font-medium text-foreground">{t.connectTitle}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t.connectHint}
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <a
            href={BROWSER_EXTENSION_INSTALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center justify-center rounded-md bg-action px-3 text-xs font-medium text-action-foreground transition-colors hover:bg-action/90"
          >
            {t.installAction}
          </a>
          <a
            href="#browser-profiles"
            className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            {t.connectAction}
          </a>
        </div>
      </div>
    </div>
  );
}

export default function BrowsersIndexPage(props: {
  params: Promise<{ workspaceId: string }>;
}) {
  void props;
  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <BrowsersEmptyState />
        <div id="browser-profiles" className="scroll-mt-4">
          <BrowserProfilesSection />
        </div>
      </div>
    </div>
  );
}
