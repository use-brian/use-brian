"use client";

import { useEffect, useState } from "react";
import { desktopBridge } from "@/lib/desktop-auth-source";
import { automaticDesktopBrowser } from "@/lib/automatic-desktop-browser";
import { useT } from "@/lib/i18n/client";
import { Checkbox } from "@/components/ui/checkbox";

/** Native device preference; never stored in a renderer account's localStorage.
 * [COMP:app-web/automatic-desktop-browser] */
export function DesktopBrowserSettings() {
  const copy = useT().computer.connectBrowser.desktop;
  const control = desktopBridge()?.browserControl;
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!control) return;
    void control({ type: "status" }).then(result => {
      if (cancelled) return;
      if (!result.ok) { setError(true); return; }
      // Older shells do not support the preference; do not offer a nonworking switch.
      setEnabled(result.browserEnabled);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [control]);
  if (!control || (enabled === undefined && !error)) return null;
  const save = async (next: boolean) => {
    setBusy(true); setError(false);
    try {
      const result = await control({ type: "set-enabled", enabled: next });
      if (!result.ok || result.browserEnabled !== next) throw new Error("Preference not saved");
      setEnabled(next);
      automaticDesktopBrowser.preferencesChanged();
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return <section className="space-y-2 border-t border-border pt-6">
    <label className="flex min-h-8 max-md:min-h-11 cursor-pointer items-center justify-between gap-4 text-sm" htmlFor="desktop-browser-enabled">
      <span className="font-medium">{copy.settingTitle}</span>
      <Checkbox id="desktop-browser-enabled" checked={enabled ?? false} disabled={busy || enabled === undefined} onCheckedChange={next => void save(next)} />
    </label>
    <p className="text-sm text-muted-foreground">{copy.settingDescription}</p>
    {error && <p role="alert" className="text-sm text-destructive">{copy.settingError}</p>}
  </section>;
}
