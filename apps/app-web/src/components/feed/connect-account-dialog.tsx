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
import { Check, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { authFetch } from "@/lib/auth-fetch";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { Button } from "@/components/ui/button";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { buildAuthorizeUrl } from "@/lib/feed-connect-account";
import {
  FEED_CONNECTABLE_PLATFORMS,
  type ConnectableFeedPlatform,
} from "@/lib/feed-nav";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const CONNECT_ATTEMPT_TIMEOUT_MS = 15_000;

type DistributionAssistant = { id: string; name: string };
type ActiveAuthorization = {
  controller: AbortController;
  timeoutId: ReturnType<typeof setTimeout>;
};

function abortableAuthFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Request aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Request aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void authFetch(url, { ...init, signal }).then(
      (response) => {
        cleanup();
        resolve(response);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function useConnectAccount() {
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  const isAdmin = team.role === "admin" || team.role === "owner";

  const [open, setOpen] = useState(false);
  // Connectable platforms only — Instagram/XHS draft without OAuth and
  // land on the coming-soon connection stub (feed-create-split.md D11).
  const [platform, setPlatform] = useState<ConnectableFeedPlatform>("threads");
  const [platformLocked, setPlatformLocked] = useState(false);
  const [assistants, setAssistants] = useState<DistributionAssistant[]>([]);
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeAuthorizationRef = useRef<ActiveAuthorization | null>(null);

  const abortActiveAuthorization = useCallback(() => {
    const active = activeAuthorizationRef.current;
    if (!active) return;
    clearTimeout(active.timeoutId);
    active.controller.abort();
    activeAuthorizationRef.current = null;
  }, []);

  useEffect(
    () => () => {
      abortActiveAuthorization();
    },
    [abortActiveAuthorization],
  );

  const closeDialog = useCallback(() => {
    abortActiveAuthorization();
    setBusy(false);
    setOpen(false);
  }, [abortActiveAuthorization]);

  const openConnect = useCallback(
    async (requestedPlatform?: ConnectableFeedPlatform) => {
      abortActiveAuthorization();
      setError(null);
      setBusy(false);
      setPlatform(requestedPlatform ?? FEED_CONNECTABLE_PLATFORMS[0]);
      setPlatformLocked(requestedPlatform !== undefined);
      setAssistants([]);
      setMode("new");
      setSelectedId(null);
      setNewName("");
      setOpen(true);
      try {
        const res = await authFetch(
          `${API_URL}/api/workspaces/${team.workspaceId}`,
        );
        if (res.ok) {
          const body = (await res.json()) as {
            assistants?: {
              id: string;
              name: string;
              kind: string;
              appType: string | null;
            }[];
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
    },
    [abortActiveAuthorization, team.workspaceId],
  );

  const platformLabel = t.platformLabels[platform];
  const canAuthorize =
    mode === "existing" ? selectedId !== null : newName.trim().length > 0;

  async function authorize() {
    abortActiveAuthorization();
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CONNECT_ATTEMPT_TIMEOUT_MS);
    activeAuthorizationRef.current = { controller, timeoutId };
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
        const res = await abortableAuthFetch(
          `${API_URL}/api/assistants`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name,
              kind: "app",
              appType: "distribution",
              workspaceId: team.workspaceId,
            }),
          },
          controller.signal,
        );
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(b?.error ?? t.connect.errorCreateVoice);
        }
        const created = (await res.json()) as { id: string };
        assistantId = created.id;
        setAssistants((current) =>
          current.some((assistant) => assistant.id === created.id)
            ? current
            : [...current, { id: created.id, name }],
        );
        setMode("existing");
        setSelectedId(created.id);
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
      const res = await abortableAuthFetch(url, {}, controller.signal);
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error ?? t.connect.errorAuthorize);
      }
      const data = (await res.json()) as { redirect: string };
      window.location.href = data.redirect;
    } catch (err) {
      if (timedOut) {
        setError(t.connect.errorTimedOut);
      } else if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : t.connect.errorGeneric);
      }
    } finally {
      if (activeAuthorizationRef.current?.controller === controller) {
        clearTimeout(timeoutId);
        activeAuthorizationRef.current = null;
        setBusy(false);
      }
    }
  }

  const dialog = (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else closeDialog();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm transition-opacity duration-150",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          )}
        />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-[calc(100vw-2rem)] max-w-md rounded-2xl border border-border bg-background p-6 shadow-xl ring-1 ring-foreground/5 outline-none",
            "transition-all duration-150",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
          )}
        >
          <div>
            <div className="flex items-center gap-2.5">
              {platformLocked ? (
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                  <PlatformIcon platform={platform} className="size-4" />
                </span>
              ) : null}
              <Dialog.Title className="text-base font-semibold text-foreground">
                {platformLocked
                  ? format(t.connect.platformTitle, { platform: platformLabel })
                  : t.connect.title}
              </Dialog.Title>
            </div>
            <Dialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {t.connect.description}
            </Dialog.Description>
          </div>

          <div className="mt-5 space-y-5">
            {!platformLocked ? (
              <div>
                <div className="mb-2 text-[11px] font-medium text-muted-foreground">
                  {t.connect.platformLabel}
                </div>
                <div
                  className="grid grid-cols-2 gap-2"
                  role="group"
                  aria-label={t.connect.platformLabel}
                >
                  {FEED_CONNECTABLE_PLATFORMS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      disabled={busy}
                      onClick={() => setPlatform(p)}
                      aria-pressed={platform === p}
                      className={cn(
                        "press flex h-10 items-center gap-2 rounded-lg border px-3 text-[13px] font-medium transition-colors",
                        platform === p
                          ? "border-foreground/25 bg-muted text-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                    >
                      <PlatformIcon platform={p} className="size-3.5" />
                      <span className="flex-1 text-left">
                        {t.platformLabels[p]}
                      </span>
                      {platform === p ? (
                        <Check className="size-3.5" aria-hidden />
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div>
              <div className="mb-2 text-[11px] font-medium text-muted-foreground">
                {t.connect.voiceLabel}
              </div>
              <div
                className="space-y-2"
                role="radiogroup"
                aria-label={t.connect.voiceLabel}
              >
                {assistants.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setMode("existing");
                      setSelectedId(a.id);
                    }}
                    role="radio"
                    aria-checked={mode === "existing" && selectedId === a.id}
                    className={cn(
                      "press flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                      mode === "existing" && selectedId === a.id
                        ? "border-foreground/25 bg-muted/70"
                        : "border-border bg-background hover:bg-muted/60",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {a.name}
                    </span>
                    {mode === "existing" && selectedId === a.id ? (
                      <Check className="size-4 text-muted-foreground" aria-hidden />
                    ) : null}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setMode("new");
                    setSelectedId(null);
                  }}
                  role="radio"
                  aria-checked={mode === "new"}
                  className={cn(
                    "press flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    mode === "new"
                      ? "border-foreground/25 bg-muted/70"
                      : "border-border bg-background hover:bg-muted/60",
                  )}
                >
                  <Plus className="size-4 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 text-sm font-medium">
                    {t.connect.newVoice}
                  </span>
                  {mode === "new" ? (
                    <Check className="size-4 text-muted-foreground" aria-hidden />
                  ) : null}
                </button>
                {mode === "new" && (
                  <input
                    autoFocus
                    disabled={busy}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={t.connect.voiceNamePlaceholder}
                    className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                  />
                )}
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {error}
              </div>
            )}
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={closeDialog}
            >
              {t.connect.cancel}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={busy || !canAuthorize}
              onClick={authorize}
              className="border-foreground bg-foreground px-4 text-background hover:bg-foreground/90 hover:text-background"
            >
              {busy
                ? t.connect.connecting
                : format(t.connect.authorizePlatform, {
                    platform: platformLabel,
                  })}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );

  return { openConnect, dialog, isAdmin };
}
