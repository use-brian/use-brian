"use client";

import { Check, Copy, Link2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { isValidInternalAlias, type InternalAliasKind } from "@use-brian/shared/desktop-links";
import { Button } from "@/components/ui/button";
import {
  checkInternalLinkAlias,
  ensureInternalLink,
  getInternalLinkCapabilities,
  InternalLinkApiError,
  renameInternalLinkAlias,
  type InternalLinkValue,
} from "@/lib/api/internal-links";
import { docPublicUrl } from "@/lib/doc-public-url";
import { useT } from "@/lib/i18n/client";
import { WORKSPACE_IDENTITY_REFRESH_EVENT, type WorkspaceIdentityRefreshDetail } from "@/lib/workspace-identity-events";

/** Authorized alias editor shared by Page Share and Workspace Settings. */
export function InternalLinkControl({
  workspaceId,
  pageId,
  canManage,
  showCopy = false,
}: {
  workspaceId: string;
  pageId?: string;
  canManage: boolean;
  showCopy?: boolean;
}) {
  const t = useT().internalLinks;
  const kind: InternalAliasKind = pageId ? "page" : "workspace";
  const targetId = pageId ?? workspaceId;
  const [supported, setSupported] = useState<boolean | null>(null);
  const [value, setValue] = useState<InternalLinkValue | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "checking" | "available" | "taken" | "invalid" | "saving" | "error">("idle");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const capabilities = await getInternalLinkCapabilities();
    const aliases = capabilities.internalLinkAliasesVersion === 1;
    setSupported(aliases);
    if (!aliases) return;
    try {
      const next = await ensureInternalLink(workspaceId, pageId);
      setValue(next);
      setDraft(pageId ? next.pageAlias ?? "" : next.workspaceAlias);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }, [pageId, workspaceId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceIdentityRefreshDetail>).detail;
      if (!detail?.workspaceId || detail.workspaceId === workspaceId) void load();
    };
    window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT, refresh);
  }, [load, workspaceId]);

  useEffect(() => {
    const current = pageId ? value?.pageAlias : value?.workspaceAlias;
    if (!canManage || !draft || draft === current) {
      setStatus((present) => present === "saving" || present === "error" ? present : "idle");
      return;
    }
    if (!isValidInternalAlias(draft, kind)) {
      setStatus("invalid");
      return;
    }
    setStatus("checking");
    let live = true;
    const timer = window.setTimeout(() => {
      void checkInternalLinkAlias({ kind, id: targetId, alias: draft }).then((result) => {
        if (!live) return;
        setStatus(result.available ? "available" : "taken");
        setSuggestion(result.suggestion ?? null);
      }).catch(() => { if (live) setStatus("error"); });
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [canManage, draft, kind, pageId, targetId, value]);

  if (supported === false) return null;

  const preview = value
    ? docPublicUrl(`/s/${encodeURIComponent(value.workspaceAlias)}${value.pageAlias ? `/${encodeURIComponent(value.pageAlias)}` : ""}`)
    : null;
  const currentAlias = pageId ? value?.pageAlias : value?.workspaceAlias;
  const changed = Boolean(draft && draft !== currentAlias);

  async function save() {
    if (!changed || status === "invalid" || status === "taken" || status === "saving") return;
    setStatus("saving");
    setSuggestion(null);
    try {
      const next = await renameInternalLinkAlias({ kind, id: targetId, alias: draft });
      setValue(next);
      setDraft(pageId ? next.pageAlias ?? "" : next.workspaceAlias);
      setStatus("idle");
    } catch (error) {
      if (error instanceof InternalLinkApiError && error.status === 409) {
        setStatus("taken");
        setSuggestion(error.suggestion ?? null);
      } else {
        setStatus("error");
      }
    }
  }

  async function copy() {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setStatus("error");
    }
  }

  return (
    <section className="space-y-2 rounded-xl border border-border p-3" aria-busy={supported === null || status === "saving"}>
      <div className="flex items-center gap-2">
        <Link2 aria-hidden className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{pageId ? t.pageLink : t.workspaceLink}</h3>
      </div>
      {value ? (
        <>
          <p className="truncate text-xs text-muted-foreground" title={preview ?? undefined}>{preview}</p>
          {canManage ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 space-y-1 text-xs font-medium">
                <span>{t.aliasLabel}</span>
                <input
                  value={draft}
                  onChange={(event) => { setDraft(event.target.value.trim().toLowerCase()); setSuggestion(null); }}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="h-11 md:h-9 w-full rounded-lg border border-border bg-background px-3 text-[16px] outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 sm:text-sm"
                />
              </label>
              <Button className="max-sm:min-h-11" disabled={!changed || status === "checking" || status === "invalid" || status === "taken" || status === "saving"} onClick={() => void save()}>
                {status === "saving" ? t.aliasSaving : t.aliasSave}
              </Button>
            </div>
          ) : null}
          {status === "checking" ? <p className="text-xs text-muted-foreground">{t.aliasChecking}</p> : null}
          {status === "available" ? <p className="text-xs text-emerald-600">{t.aliasAvailable}</p> : null}
          {status === "invalid" ? <p role="alert" className="text-xs text-destructive">{t.aliasInvalid}</p> : null}
          {status === "taken" ? <p role="alert" className="text-xs text-destructive">{suggestion ? `${t.aliasTaken} ${t.aliasSuggestion.replace("{alias}", suggestion)}` : t.aliasTaken}</p> : null}
          {status === "error" ? <p role="alert" className="text-xs text-destructive">{t.aliasError}</p> : null}
          {canManage ? <p className="text-xs text-muted-foreground">{t.aliasHistoryHint}</p> : null}
          {showCopy ? (
            <Button variant="outline" className="max-sm:min-h-11" onClick={() => void copy()}>
              {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
              {copied ? t.aliasCopied : t.aliasCopy}
            </Button>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{status === "error" ? t.aliasError : t.aliasLoading}</p>
      )}
    </section>
  );
}
