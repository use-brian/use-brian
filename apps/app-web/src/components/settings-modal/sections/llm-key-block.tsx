"use client";

/**
 * Bring-your-own Gemini API key block for the active workspace. The server
 * only ever returns a masked status ({ provider, isSet, last4 }) — the raw
 * key is write-only here (PUT to set/replace, DELETE to remove) and never
 * rendered back. Owner/admin gated server-side: a 404 (BYO not configured)
 * or 403 (not owner/admin) degrades to a disabled "not available" state
 * instead of erroring.
 *
 * Extracted from `workspace-sections.tsx` so it can render in two homes:
 * hosted embeds it in the Models section (`sections/models-section.tsx`,
 * one place for everything model-related), while the OSS edition — which
 * has no Models section (the metered lane is a hosted billing construct) —
 * keeps it as the standalone `ws-llm-key` section.
 */

import { useCallback, useEffect, useState } from "react";
import {
  getLlmKeyStatus,
  setLlmKey,
  deleteLlmKey,
  LlmKeyUnavailableError,
  type LlmKeyStatus,
} from "@/lib/api/llm-keys";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { Button } from "@/components/ui/button";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";

export function WorkspaceLlmKeyBlock() {
  const t = useT();
  const ctx = useWorkspaceContext();
  const workspaceId = ctx.workspaceId;
  const tk = t.workspaceLlmKey;

  const [status, setStatus] = useState<LlmKeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const refetch = useCallback(async () => {
    if (!workspaceId) {
      setStatus(null);
      setLoading(false);
      return;
    }
    try {
      const s = await getLlmKeyStatus(workspaceId);
      setStatus(s);
      setUnavailable(false);
    } catch (e) {
      if (e instanceof LlmKeyUnavailableError) {
        setUnavailable(true);
        setStatus(null);
      } else {
        setError(tk.loadFailed);
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId, tk.loadFailed]);

  useEffect(() => {
    setLoading(true);
    void refetch();
  }, [refetch]);

  async function save() {
    if (!workspaceId) return;
    const next = keyInput.trim();
    if (!next || saving) return;
    setSaving(true);
    setError("");
    try {
      const s = await setLlmKey(workspaceId, next);
      setStatus(s);
      // Write-only: clear the input immediately; never echo the raw key back.
      setKeyInput("");
    } catch (e) {
      if (e instanceof LlmKeyUnavailableError) {
        setUnavailable(true);
      } else {
        setError(e instanceof Error ? e.message : tk.saveFailed);
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!workspaceId || removing) return;
    setRemoving(true);
    setError("");
    try {
      await deleteLlmKey(workspaceId);
      await refetch();
    } catch (e) {
      if (e instanceof LlmKeyUnavailableError) {
        setUnavailable(true);
      } else {
        setError(tk.removeFailed);
      }
    } finally {
      setRemoving(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="border-t border-border pt-6 space-y-3">
      <div>
        <h3 className="text-sm font-medium">{tk.heading}</h3>
        <p className="text-[12px] text-muted-foreground mt-0.5">{tk.description}</p>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">{t.workspaceDetailInline.loading}</div>
      ) : unavailable ? (
        <div className="rounded-lg bg-muted/30 px-3 py-2 text-[13px] text-muted-foreground">
          {tk.unavailable}
        </div>
      ) : (
        <>
          {/* Current masked status */}
          <div className="rounded-lg bg-muted/30 px-3 py-2 text-[13px]">
            {status?.isSet ? (
              <span className="font-medium">
                {format(tk.keySet, { last4: status.last4 ?? "????" })}
              </span>
            ) : (
              <span className="text-muted-foreground">{tk.noKeySet}</span>
            )}
          </div>

          {/* Write-only key input + Save */}
          <div className="space-y-2 pt-1">
            <label className="block text-[12px] font-medium text-muted-foreground">
              {status?.isSet ? tk.replaceLabel : tk.setLabel}
            </label>
            <input
              type="password"
              value={keyInput}
              onChange={(e) => {
                setKeyInput(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder={tk.inputPlaceholder}
              autoComplete="off"
              spellCheck={false}
              className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 outline-none focus:border-primary/60"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={save}
                disabled={saving || !keyInput.trim()}
                className="text-sm font-medium bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {saving ? t.workspaceDetailInline.purposeSaving : t.workspaceDetailInline.save}
              </button>
              {status?.isSet && (
                <button
                  onClick={() => setConfirmOpen(true)}
                  disabled={removing}
                  className="text-sm font-medium border border-red-400/30 text-red-400 px-4 py-2 rounded-lg hover:bg-red-400/10 transition-colors disabled:opacity-50"
                >
                  {tk.remove}
                </button>
              )}
            </div>
          </div>

          {error && <div className="text-xs text-red-400">{error}</div>}

          <p className="text-[12px] text-muted-foreground pt-1 leading-relaxed">
            {tk.helper}
          </p>
        </>
      )}

      <RemoveLlmKeyDialog
        open={confirmOpen}
        removing={removing}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={remove}
      />
    </div>
  );
}

// Confirm dialog for removing the workspace's Gemini key. Portaled base-ui
// AlertDialog layered above the settings modal (z-[60]), mirroring
// DeleteWorkspaceDialog — but a plain yes/no (no type-to-confirm gate, since
// removing the key is reversible).
function RemoveLlmKeyDialog({
  open,
  removing,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  removing: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const t = useT();
  const tk = t.workspaceLlmKey;
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !removing) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-[60] bg-background/80 backdrop-blur-sm transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-[60] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl ring-1 ring-foreground/5 transition-all duration-150 data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95">
          <AlertDialog.Title className="text-base font-semibold text-foreground">
            {tk.removeDialogTitle}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {tk.removeConfirm}
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={removing} onClick={onCancel}>
              {t.workspaceDetailInline.cancel}
            </Button>
            <Button variant="destructive" size="sm" disabled={removing} onClick={onConfirm}>
              {tk.remove}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
