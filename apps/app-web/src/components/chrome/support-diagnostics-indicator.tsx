"use client";

// [COMP:app-web/support-diagnostics] — persistent OSS Support Mode indicator.

import { useCallback, useEffect, useState } from "react";
import { Bug } from "lucide-react";
import { isOssEdition } from "@/lib/edition";
import { useT } from "@/lib/i18n/client";
import {
  getSupportDiagnosticStatus,
  SUPPORT_DIAGNOSTICS_CHANGED_EVENT,
  type SupportDiagnosticStatus,
} from "@/lib/support-diagnostics";
import { openWorkspaceSettings } from "@/components/settings-modal/settings-modal";

export function SupportDiagnosticsIndicator({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const t = useT().settings.privacy;
  const [status, setStatus] = useState<SupportDiagnosticStatus | null>(null);

  const refresh = useCallback(() => {
    if (!isOssEdition()) return;
    void getSupportDiagnosticStatus(workspaceId)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [workspaceId]);

  useEffect(() => {
    if (!isOssEdition()) return;
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener(SUPPORT_DIAGNOSTICS_CHANGED_EVENT, refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(SUPPORT_DIAGNOSTICS_CHANGED_EVENT, refresh);
    };
  }, [refresh]);

  if (!isOssEdition() || !status?.active || !status.capture) return null;

  return (
    <button
      type="button"
      onClick={() => openWorkspaceSettings("privacy")}
      className="fixed right-4 top-4 z-50 flex items-center gap-2 rounded-full border border-amber-500/35 bg-background/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg backdrop-blur hover:bg-amber-500/10"
      title={t.supportIndicatorHint}
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
      </span>
      <Bug className="h-3.5 w-3.5" />
      {t.supportIndicator}
    </button>
  );
}
