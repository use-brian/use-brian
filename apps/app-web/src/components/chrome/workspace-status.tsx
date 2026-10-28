"use client";

/**
 * One rail control for connection health and desktop updates. Connection
 * warnings take priority; details retain both states and the explicit restart.
 * Spec: docs/architecture/features/workspace-navigation.md; app-desktop.md.
 * [COMP:app-web/workspace-status]
 */

import { useEffect, useRef, useState } from "react";
import { ArrowUpCircle, CircleAlert, RefreshCw } from "lucide-react";

import { desktopBridge, type DesktopUpdateStatus } from "@/lib/desktop-auth-source";
import { useT, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { OfflineSyncState } from "@/lib/offline/use-offline-sync";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import styles from "./workspace-status.module.css";

export function WorkspaceStatus({ offlineState, sidebarOpen }: {
  offlineState: OfflineSyncState;
  sidebarOpen: boolean;
}) {
  const t = useT().docPage;
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const installingRef = useRef(false);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.getUpdateStatus || !bridge.onUpdateStatus) return;
    let live = true;
    let receivedPush = false;
    const unsubscribe = bridge.onUpdateStatus((next) => {
      receivedPush = true;
      if (live) setStatus(next);
    });
    void bridge.getUpdateStatus().then(
      (initial) => {
        if (live && !receivedPush) setStatus(initial);
      },
      () => {},
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    installingRef.current = false;
    setInstalling(false);
  }, [status?.phase, status?.version]);

  const hasSyncNotice = offlineState.offline || offlineState.pending > 0 || offlineState.paused > 0 || offlineState.reconnecting;
  const hasDetails = hasSyncNotice || status !== null;
  const syncTitle = offlineState.paused > 0 ? t.offlineSyncPausedTitle
    : offlineState.offline ? t.offlineBannerTitle
    : offlineState.reconnecting ? t.errors.collabReconnecting
    : offlineState.pending > 0 ? t.offlineSyncPendingTitle : t.offlineStatusOnline;
  const syncDescription = offlineState.paused > 0
    ? format(t.offlineSyncPausedBody, { count: offlineState.paused })
    : offlineState.pending > 0
    ? format(offlineState.offline ? t.offlineBannerPending : t.offlineSyncPendingBody, { count: offlineState.pending })
    : offlineState.offline ? t.offlineBannerBody : "";
  const percent = status?.phase === "downloading" ? Math.max(0, Math.min(100, Math.round(status.percent))) : 0;
  const updateTitle = status?.phase === "ready" ? t.desktopUpdateReady
    : status ? format(t.desktopUpdateDownloading, { percent }) : "";
  const updateDescription = status ? format(status.phase === "ready" ? t.desktopUpdateReadyTitle : t.desktopUpdateDownloadingTitle, { version: status.version }) : "";
  const label = hasSyncNotice || !status ? syncTitle : updateTitle;
  const secondaryLabel = status ? (hasSyncNotice ? updateTitle : syncTitle) : syncDescription;
  const reconnecting = offlineState.reconnecting && !offlineState.offline && offlineState.paused === 0;

  function restart() {
    const bridge = desktopBridge();
    if (installingRef.current || !bridge?.installUpdate) return;
    installingRef.current = true;
    setInstalling(true);
    bridge.installUpdate();
  }

  return (
    <div
      data-workspace-sync-status
      data-desktop-update={status?.phase}
      data-workspace-status={hasSyncNotice ? "attention" : status?.phase ?? "online"}
      className={cn(
        "pointer-events-auto relative z-10 min-w-0 shrink md:flex md:w-14 md:shrink-0 md:justify-center",
        !sidebarOpen && !hasSyncNotice && !status && "max-md:hidden",
        hasSyncNotice ? "text-amber-700 dark:text-amber-300" : status ? "text-primary" : "text-muted-foreground",
      )}
    >
      {/* Progress is available on demand, but only phase/connection changes
          announce automatically. Percent pushes must not flood a live region. */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {syncTitle}{syncDescription ? `. ${syncDescription}` : ""}{status ? `. ${updateDescription}` : ""}
      </span>
      <Popover open={detailsOpen} onOpenChange={(open) => { setDetailsOpen(open); setTooltipOpen(false); }}>
        <Tooltip open={tooltipOpen && !detailsOpen} onOpenChange={setTooltipOpen} side="right" sideOffset={4} delay={100} appearance="rail" label={<span className="block max-w-64 whitespace-normal">{label}{secondaryLabel ? <span className="mt-1 block text-white/70">{secondaryLabel}</span> : null}</span>}>
          <PopoverTrigger aria-label={status ? `${label}. ${secondaryLabel}` : label} className={cn(
            "flex h-11 max-w-full items-center gap-2 rounded-lg px-3 hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:h-7 md:w-11 md:justify-center md:px-0",
            status?.phase === "ready" && !hasSyncNotice && "bg-primary/10 hover:bg-primary/15",
            !sidebarOpen && "max-md:bg-background max-md:shadow-sm max-md:ring-1 max-md:ring-border",
          )}>
            {hasSyncNotice ? (
              reconnecting ? <RefreshCw aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : <CircleAlert aria-hidden className="size-3.5 shrink-0" />
            ) : status?.phase === "downloading" ? (
              <RefreshCw aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
            ) : status?.phase === "ready" ? (
              <ArrowUpCircle aria-hidden className="size-4 shrink-0" />
            ) : (
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
            )}
            <span className="min-w-0 truncate font-medium md:sr-only">{label}</span>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent
          side={hasDetails ? "top" : "right"}
          align={hasDetails ? "start" : "center"}
          sideOffset={hasDetails ? 8 : 4}
          aria-label={label}
          className={hasDetails
            ? "w-[min(18rem,calc(100vw-1rem))] gap-3 text-sm"
            : styles.onlineLabel}
        >
          {hasDetails ? <>
            <div className="space-y-1">
              <p className="font-medium">{syncTitle}</p>
              {syncDescription ? <p className="text-muted-foreground">{syncDescription}</p> : null}
            </div>
            {status ? <div className="space-y-2 border-t border-border pt-3">
              <p className="font-medium">{updateTitle}</p>
              <p className="text-muted-foreground">{updateDescription}</p>
              {status.phase === "downloading" ? (
                <div role="progressbar" aria-label={updateDescription} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 overflow-hidden rounded-full bg-primary/15">
                  <div className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />
                </div>
              ) : (
                <Button type="button" onClick={restart} disabled={installing} className="w-full">
                  <RefreshCw aria-hidden className={cn("size-3.5", installing && "animate-spin motion-reduce:animate-none")} />
                  {installing ? t.desktopUpdateRestarting : t.desktopUpdateRestart}
                </Button>
              )}
            </div> : null}
          </> : label}
        </PopoverContent>
      </Popover>
    </div>
  );
}
