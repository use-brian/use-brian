"use client";

/**
 * In-app workspace-creation form, used by the workspace switcher's
 * create mode.
 *
 * Ported from apps/web's workspace-switcher create panel
 * (`apps/web/src/components/chrome/workspace-switcher.tsx`). app-web
 * used to bounce out to `usebrian.ai/settings` to create a workspace; this
 * keeps creation in-app. The per-plan creation gate still lives in the
 * backend (`POST /api/workspaces` → 403 `plan_required` for a user who
 * owns no paid workspace and already has one non-personal workspace);
 * we surface that message inline rather than re-implement the gate here.
 *
 * Renders only the fields + actions; the caller supplies the chrome
 * (popover panel vs. full-page card) and decides what to do with the
 * created workspace via `onCreated`.
 *
 * [COMP:app-web/create-workspace-form]
 */

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type CreatedWorkspace = {
  id: string;
  name: string;
  iconSeed: number | null;
};

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function CreateWorkspaceForm({
  onCreated,
  onCancel,
  autoFocus = false,
}: {
  onCreated: (workspace: CreatedWorkspace) => void;
  /** When provided, renders a Cancel button. Omit on surfaces with
   *  nowhere to go back to. */
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const t = useT().workspaceSwitcher.create;
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && purpose.trim().length >= 10;

  async function handleCreate() {
    const n = name.trim();
    const p = purpose.trim();
    if (!n || p.length < 10 || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n, purpose: p }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        // The backend's plan gate returns 403 `{ error: 'plan_required',
        // message }` — prefer the human message, fall back to a generic.
        setError(err.message ?? err.error ?? t.errorGeneric);
        return;
      }
      const created = (await res.json()) as CreatedWorkspace;
      onCreated(created);
    } catch {
      setError(t.errorNetwork);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 text-left">
      <input
        type="text"
        autoFocus={autoFocus}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        placeholder={t.namePlaceholder}
        maxLength={100}
        className={cn(
          "w-full text-sm bg-muted/50 border border-border rounded-md",
          "px-3 py-2 outline-none focus:border-primary/60",
        )}
      />
      <textarea
        value={purpose}
        onChange={(e) => {
          setPurpose(e.target.value);
          setError(null);
        }}
        placeholder={t.purposePlaceholder}
        rows={3}
        maxLength={500}
        className={cn(
          "w-full text-sm bg-muted/50 border border-border rounded-md",
          "px-3 py-2 outline-none focus:border-primary/60 resize-none",
        )}
      />
      <div className="text-[11px] text-muted-foreground px-0.5">
        {t.purposeMinHint}
      </div>
      {error && (
        <div className="text-[12px] text-destructive px-0.5">{error}</div>
      )}
      <div className="flex justify-end gap-2 pt-0.5">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              "inline-flex items-center justify-center",
              "rounded-md border border-border bg-card hover:bg-muted",
              "px-3 py-1.5 text-xs transition-colors",
            )}
          >
            {t.cancel}
          </button>
        )}
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating || !canSubmit}
          className={cn(
            "inline-flex items-center justify-center",
            "rounded-md bg-primary text-primary-foreground hover:bg-primary/90",
            "px-3 py-1.5 text-xs font-medium transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {creating ? t.submitting : t.submit}
        </button>
      </div>
    </div>
  );
}
