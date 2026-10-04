"use client";

/**
 * Desktop shell self-update chip, beside the footer sync status.
 *
 * The Electron shell pushes its update state through the preload bridge
 * (`getUpdateStatus` / `onUpdateStatus`): while a release downloads the chip
 * reads "Updating N%", and once it is staged it becomes a one-click restart
 * (`installUpdate`). Renders nothing in a browser, in shells older than the
 * bridge, and whenever the shell has nothing to report.
 *
 * Spec: docs/architecture/features/app-desktop.md → "Auto-update"
 * [COMP:app-web/desktop-update-chip]
 */

import { useEffect, useState } from "react";
import { ArrowDownCircle, RefreshCw } from "lucide-react";

import { desktopBridge, type DesktopUpdateStatus } from "@/lib/desktop-auth-source";
import { useT, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

export function DesktopUpdateChip({ className }: { className?: string }) {
  const t = useT().docPage;
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.getUpdateStatus || !bridge.onUpdateStatus) return;
    let live = true;
    const unsubscribe = bridge.onUpdateStatus((next) => {
      if (live) setStatus(next);
    });
    void bridge.getUpdateStatus().then(
      (initial) => {
        if (live) setStatus((current) => current ?? initial);
      },
      () => {},
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  if (!status) return null;

  if (status.phase === "downloading") {
    return (
      <span
        data-desktop-update="downloading"
        title={format(t.desktopUpdateDownloadingTitle, { version: status.version })}
        className={cn("flex shrink-0 items-center gap-1 text-muted-foreground", className)}
      >
        <RefreshCw aria-hidden className="size-3 animate-spin" />
        {format(t.desktopUpdateDownloading, { percent: status.percent })}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-desktop-update="ready"
      title={format(t.desktopUpdateReadyTitle, { version: status.version })}
      aria-label={format(t.desktopUpdateReadyTitle, { version: status.version })}
      onClick={() => desktopBridge()?.installUpdate?.()}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 font-medium text-foreground transition-colors hover:bg-muted",
        className,
      )}
    >
      <ArrowDownCircle aria-hidden className="size-3" />
      {t.desktopUpdateReady}
    </button>
  );
}
