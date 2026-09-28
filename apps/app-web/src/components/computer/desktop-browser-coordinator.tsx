"use client";

import { useEffect, useSyncExternalStore } from "react";
import { desktopBridge } from "@/lib/desktop-auth-source";
import { automaticDesktopBrowser as browser, type LocalProfile } from "@/lib/automatic-desktop-browser";
import { listBrowserProfiles } from "@/lib/api/computer";
import { useCachedResource } from "@/lib/surface-cache";
import { browserProfilesCacheKey } from "@/lib/surface-prefetch";
import { useT } from "@/lib/i18n/client";

export function DesktopBrowserState({ workspaceId, profileId, onConnectionChange }: {
  workspaceId: string; profileId?: string;
  onConnectionChange?: (profileId: string, connected: boolean) => void;
}) {
  const state = useSyncExternalStore(browser.subscribe, browser.snapshot, browser.serverSnapshot);
  const c = useT().computer.connectBrowser;
  const matches = state.workspaceId === workspaceId && (!profileId || state.profileId === profileId);
  const phase = matches ? state.phase : "idle";
  useEffect(() => {
    if (profileId) onConnectionChange?.(profileId, phase === "connected");
  }, [profileId, phase, onConnectionChange]);
  if (!profileId && (!matches || !state.profileId)) return null;
  const label = phase === "connected" ? c.desktop.connected : phase === "connecting" ? c.oneClickConnecting :
    phase === "paused" ? c.desktop.paused : phase === "failed" ? c.desktop.failed : c.desktop.automatic;
  return <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1 text-xs" aria-live="polite">
    <span>{c.desktop.title}: {label}</span>
    {phase === "connected" ? <button type="button" className="min-h-11 rounded-md border px-3 hover:bg-accent" onClick={() => void browser.show().catch(() => {})}>{c.desktop.open}</button> : null}
    {phase === "paused" || phase === "failed" ? <button type="button" className="min-h-11 rounded-md border px-3 hover:bg-accent" onClick={() => void browser.retry()}>{phase === "paused" ? c.desktop.resume : c.desktop.retry}</button> : null}
  </div>;
}

/** The only lifecycle owner, mounted in the persistent workspace chrome. */
export function DesktopBrowserCoordinator({ workspaceId }: { workspaceId: string }) {
  const desktop = !!desktopBridge()?.browserControl;
  const cacheKey = desktop && workspaceId ? browserProfilesCacheKey(workspaceId) : null;
  const roster = useCachedResource(cacheKey,
    () => listBrowserProfiles(workspaceId));
  // Only lifecycle-relevant changes cancel pending work, not name edits or revalidation.
  const signature = roster.data ? JSON.stringify(roster.data.configured ? roster.data.profiles.map(p => ({
    id: p.id, defaultBackend: p.defaultBackend, canManage: p.canManage,
  })).sort((a, b) => a.id.localeCompare(b.id)) : []) : undefined;
  useEffect(() => {
    if (!desktop || signature === undefined) { browser.leave(); return; }
    browser.configure(workspaceId, JSON.parse(signature) as LocalProfile[]);
    const timer = setInterval(() => void browser.check(), 5000);
    const check = () => { void browser.check(); };
    window.addEventListener("focus", check);
    return () => { clearInterval(timer); window.removeEventListener("focus", check); browser.leave(); };
  }, [desktop, workspaceId, cacheKey, signature]);
  return null;
}
