"use client";

/**
 * Connect-an-account dialog — ported faithfully from
 * `apps/feed-web/src/components/connect-account-dialog.tsx`
 * (docs/plans/feed-web-consolidation.md §7.1, disposition rules §6).
 *
 * Picks a platform + an owning voice (an existing distribution assistant, or
 * a new one created inline), then redirects into the platform OAuth flow.
 * The OAuth callback returns to `/w/<id>/feed?connected=<platform>` (built by
 * `buildAuthorizeUrl`), where the feed home banners the success and refreshes
 * profiles. Render {dialog} once and call openConnect() from a trigger.
 * Admin/owner only.
 *
 * Port deltas: `useWorkspaceContext()` → `useFeedWorkspace()`; platform list
 * derived from `FEED_CONNECTABLE_PLATFORMS`; copy via `useT().feedPage.connect`.
 *
 * [COMP:app-web/feed-connect-account-dialog]
 */

import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { authFetch } from "@/lib/auth-fetch";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { buildAuthorizeUrl } from "@/lib/feed-connect-account";
import {
  FEED_CONNECTABLE_PLATFORMS,
  type ConnectableFeedPlatform,
} from "@/lib/feed-nav";
import { useT } from "@/lib/i18n/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type DistributionAssistant = { id: string; name: string };

export function useConnectAccount() {
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  const isAdmin = team.role === "admin" || team.role === "owner";

  const [open, setOpen] = useState(false);
  // Connectable platforms only — Instagram/XHS draft without OAuth and
  // land on the coming-soon connection stub (feed-create-split.md D11).
  const [platform, setPlatform] = useState<ConnectableFeedPlatform>("threads");
  const [assistants, setAssistants] = useState<DistributionAssistant[]>([]);
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openConnect = useCallback(async () => {
    setError(null);
    setBusy(false);
    setPlatform("threads");
    setNewName("");
    setOpen(true);
    try {
      const res = await authFetch(`${API_URL}/api/workspaces/${team.workspaceId}`);
      if (res.ok) {
        const body = (await res.json()) as {
          assistants?: { id: string; name: string; kind: string; appType: string | null }[];
        };
        const dist = (body.assistants ?? []).filter(
          (a) => a.kind === "app" && a.appType === "distribution",
        );
        setAssistants(dist.map((a) => ({ id: a.id, name: a.name })));
        if (dist.length > 0) {
          setMode("existing");
          setSelectedId(dist[0].id);
        } else {
          setMode("new");
          setSelectedId(null);
        }
      }
    } catch {
      setAssistants([]);
      setMode("new");
    }
  }, [team.workspaceId]);

  async function authorize() {
    setBusy(true);
    setError(null);
    try {
      let assistantId = selectedId;
      if (mode === "new") {
        const name = newName.trim();
        if (!name) {
          setError(t.connect.errorNameRequired);
          setBusy(false);
          return;
        }
        const res = await authFetch(`${API_URL}/api/assistants`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            kind: "app",
            appType: "distribution",
            workspaceId: team.workspaceId,
          }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(b?.error ?? t.connect.errorCreateVoice);
        }
        const created = (await res.json()) as { id: string };
        assistantId = created.id;
      }
      if (!assistantId) {
        setError(t.connect.errorChooseVoice);
        setBusy(false);
        return;
      }
      const url = buildAuthorizeUrl({
        apiUrl: API_URL,
        platform,
        assistantId,
        origin: window.location.origin,
        workspaceId: team.workspaceId,
      });
      const res = await authFetch(url);
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error ?? t.connect.errorAuthorize);
      }
      const data = (await res.json()) as { redirect: string };
      window.location.href = data.redirect;
    } catch (err) {
      setError(err instanceof Error ? err.message : t.connect.errorGeneric);
      setBusy(false);
    }
  }

  const dialog = (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-black/55 backdrop-blur-sm",
            "data-[open]:animate-fade-in",
            "data-[closed]:opacity-0 data-[closed]:transition-opacity data-[closed]:duration-150",
          )}
        />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-[calc(100vw-2rem)] max-w-md outline-none",
            "rounded-2xl border border-border bg-card shadow-2xl",
            "data-[open]:animate-pop-in",
            "data-[closed]:opacity-0 data-[closed]:scale-[0.97] data-[closed]:transition-all data-[closed]:duration-150",
          )}
        >
          <div className="px-5 pt-5 pb-2">
            <Dialog.Title className="text-base font-semibold">{t.connect.title}</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground leading-relaxed">
              {t.connect.description}
            </Dialog.Description>
          </div>

          <div className="px-5 py-3 space-y-4">
            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground mb-1.5">{t.connect.platformLabel}</div>
              <div className="grid grid-cols-2 gap-2">
                {FEED_CONNECTABLE_PLATFORMS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPlatform(p)}
                    className={cn(
                      "press rounded-lg border px-3 h-9 text-[13px] font-medium transition-colors",
                      platform === p
                        ? "border-transparent bg-foreground text-background"
                        : "border-border bg-background/60 text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {t.platformLabels[p]}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground mb-1.5">{t.connect.voiceLabel}</div>
              <div className="space-y-2">
                {assistants.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => { setMode("existing"); setSelectedId(a.id); }}
                    className={cn(
                      "press w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                      mode === "existing" && selectedId === a.id
                        ? "border-primary/50 bg-primary/10"
                        : "border-border bg-background/60 hover:bg-accent",
                    )}
                  >
                    <span className="text-sm font-medium truncate">{a.name}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => { setMode("new"); setSelectedId(null); }}
                  className={cn(
                    "press w-full rounded-xl border px-3 py-2.5 text-left transition-colors",
                    mode === "new" ? "border-primary/50 bg-primary/10" : "border-border bg-background/60 hover:bg-accent",
                  )}
                >
                  <span className="text-sm font-medium">{t.connect.newVoice}</span>
                </button>
                {mode === "new" && (
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={t.connect.voiceNamePlaceholder}
                    className="w-full rounded-lg border border-border bg-background px-3 h-9 text-sm outline-none focus:border-primary/50"
                  />
                )}
              </div>
            </div>

            {error && (
              <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
            <button
              type="button"
              disabled={busy}
              onClick={() => setOpen(false)}
              className="press inline-flex items-center justify-center h-9 px-4 rounded-xl text-sm font-medium text-foreground bg-transparent border border-border hover:bg-accent disabled:opacity-50"
            >
              {t.connect.cancel}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={authorize}
              className="press inline-flex items-center justify-center h-9 px-4 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? t.connect.connecting : t.connect.authorize}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );

  return { openConnect, dialog, isAdmin };
}
