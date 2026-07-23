"use client";

/**
 * Browsers surface index (`/w/[id]/computer`) — the full-width prompt shown
 * when no session is selected. The live-session list (owned by the left
 * sidebar's `BrowsersSidebarPanel`) picks a session; a row routes to
 * `/computer/<sessionId>`, which fills this pane with the Take-Over view.
 *
 * [COMP:app-web/browsers-surface]
 */

import { MonitorPlay } from "lucide-react";
import { useT } from "@/lib/i18n/client";

export default function BrowsersIndexPage() {
  const t = useT().computer.sessions;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <MonitorPlay className="size-8 text-muted-foreground/50" aria-hidden />
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium text-foreground">{t.selectTitle}</p>
        <p className="text-xs text-muted-foreground">{t.selectHint}</p>
      </div>
    </div>
  );
}
