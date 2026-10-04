"use client";

import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { useEffect, useState } from "react";
import { HOME_APP_TOOL_CONFIG, homeAppToolSetCapability } from "@use-brian/shared";
import { authFetch } from "@/lib/auth-fetch";
const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";
import { useT } from "@/lib/i18n/client";
import { AssociationModuleNote } from "@/components/association/module-controls";

type Grant = { capability: string; enabled: boolean };

/** Per-assistant app and set grants. Writes settle before changing saved state.
 * [COMP:app-web/home-app-tool-settings]
 */
export function HomeAppToolSettings({ assistantId, workspaceId }: { assistantId: string; workspaceId?: string | null }) {
  const t = useT().assistant.toolsTab.homeApps;
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setGrants(null);
    setLoadError(false);
    authFetch(`${API_URL}/api/assistants/${assistantId}/primitive-grants`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("load failed");
        const data = await res.json() as { grants: Grant[] };
        if (!Array.isArray(data.grants)) throw new Error("invalid grants");
        if (!controller.signal.aborted) setGrants(data.grants);
      })
      .catch(() => { if (!controller.signal.aborted) setLoadError(true); });
    return () => controller.abort();
  }, [assistantId, retry]);

  async function toggle(capability: string, enabled: boolean) {
    if (pending) return;
    setPending(capability);
    setSaveError(null);
    try {
      const res = await authFetch(`${API_URL}/api/assistants/${assistantId}/primitive-grants/${encodeURIComponent(capability)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error("save failed");
      const saved = await res.json() as Grant;
      if (saved.capability !== capability || typeof saved.enabled !== "boolean") throw new Error("invalid grant");
      setGrants((prev) => prev?.map((grant) => grant.capability === capability ? saved : grant) ?? null);
    } catch {
      setSaveError(capability);
    } finally {
      setPending(null);
    }
  }

  if (loadError) return <div role="alert" className="space-y-2 text-sm text-destructive">
    <p>{t.load}</p>
    <button type="button" className="text-primary underline" onClick={() => setRetry((n) => n + 1)}>{t.retry}</button>
  </div>;
  if (!grants) return <p role="status" className="text-sm text-muted-foreground">{t.loading}</p>;

  const enabled = (cap: string) => grants.some((g) => g.capability === cap && g.enabled);
  const exists = (cap: string) => grants.some((g) => g.capability === cap);
  const switchFor = (cap: string, label: string, disabled = false) => <button
    type="button" role="switch" aria-label={label} aria-checked={enabled(cap)}
    disabled={disabled || pending !== null || !exists(cap)}
    onClick={() => void toggle(cap, !enabled(cap))}
    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${enabled(cap) ? "bg-primary" : "bg-muted"}`}
  ><span className={`inline-block h-4 w-4 rounded-full bg-background transition-transform ${enabled(cap) ? "translate-x-6" : "translate-x-1"}`} /></button>;

  return <section className="space-y-3">
    <p className="text-sm text-muted-foreground">{t.desc}</p>
    {HOME_APP_TOOL_CONFIG.map((app) => <div key={app.id} className="rounded-xl border border-border overflow-hidden">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <h3 className="text-sm font-medium">{t[app.id]}</h3>
        {switchFor(app.capability, t[app.id])}
      </div>
      <div className="border-t border-border px-4 py-3 space-y-3">
        {app.toolSets.map((set) => {
          const capability = homeAppToolSetCapability(app.id, set);
          return <div key={set} className="space-y-1">
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="text-muted-foreground">{t[set]}</span>
              {switchFor(capability, `${t[app.id]}: ${t[set]}`, !enabled(app.capability))}
            </div>
            {saveError === capability && <p role="alert" className="text-xs text-destructive">{t.save}</p>}
          </div>;
        })}
        {!enabled(app.capability) && <p className="text-xs text-muted-foreground">{t.disabled}</p>}
        {app.id === "association" && workspaceId && <AssociationModuleNote workspaceId={workspaceId} />}
        {saveError === app.capability && <p role="alert" className="text-xs text-destructive">{t.save}</p>}
      </div>
    </div>)}
  </section>;
}
