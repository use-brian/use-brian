"use client";

/**
 * Browsers surface index (`/w/[id]/computer`) — the operational home for
 * live-view landing state. Live tasks stay reachable from the persistent
 * sidebar; Browser profiles live on the explicit `/computer/profiles` mode.
 *
 * [COMP:app-web/browsers-surface]
 */

import { MonitorPlay } from "lucide-react";
import { useT } from "@/lib/i18n/client";

/** Persistent getting-started copy for the no-live-session state. */
export function BrowsersEmptyState() {
  const t = useT().computer.sessions;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <MonitorPlay className="size-8 text-muted-foreground/50" aria-hidden />
      <div className="max-w-lg space-y-1">
        <p className="text-sm font-medium text-foreground">{t.selectTitle}</p>
        <p className="text-xs text-muted-foreground">{t.selectHint}</p>
      </div>
    </div>
  );
}

export default function BrowsersIndexPage() {
  return <BrowsersEmptyState />;
}
