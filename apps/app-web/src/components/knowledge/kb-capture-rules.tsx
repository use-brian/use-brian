"use client";


import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Studio -> Knowledge -> Automatic capture.
 *
 * Workspace-wide categories are the structural gate for interactive
 * assistant KB writes. Zero rules is the normal default and means read-only.
 * [COMP:app-web/kb-capture-rules]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";
import { Pencil, Plus, Trash2 } from "lucide-react";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

type Sensitivity = "public" | "internal" | "confidential";

export type CaptureRuleSource = {
  id: string;
  repo: string;
  sourceType: "github" | "local";
  writeAccess: boolean | null;
};

type CaptureRule = {
  id: string;
  name: string;
  matchPhrases: string[];
  instructions: string;
  targetSourceId: string | null;
  pathPrefix: string;
  defaultSensitivity: Sensitivity;
  enabled: boolean;
};

type Draft = Omit<CaptureRule, "id">;

const EMPTY_DRAFT: Draft = {
  name: "",
  matchPhrases: [],
  instructions: "",
  targetSourceId: null,
  pathPrefix: "",
  defaultSensitivity: "internal",
  enabled: true,
};

function phraseText(phrases: string[]): string {
  return phrases.join("\n");
}

export function parseCapturePhrases(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((part) => part.trim()).filter(Boolean))];
}

export function KbCaptureRules({
  workspaceId,
  sources,
}: {
  workspaceId: string;
  sources: CaptureRuleSource[];
}) {
  const t = useT();
  const copy = t.studioPage.knowledgePage.capture;
  const tiers = t.studioPage.knowledgePage.tiers;
  const [rules, setRules] = useState<CaptureRule[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [phrases, setPhrases] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRules = useCallback(async () => {
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${workspaceId}/knowledge/capture-rules`,
      );
      if (!res.ok) throw new Error(copy.loadError);
      const data = (await res.json()) as { rules?: CaptureRule[]; canManage?: boolean };
      setRules(data.rules ?? []);
      setCanManage(data.canManage === true);
      setError(null);
    } catch {
      setRules([]);
      setError(copy.loadError);
    }
  }, [copy.loadError, workspaceId]);

  useEffect(() => {
    setRules(null);
    setEditingId(null);
    void fetchRules();
  }, [fetchRules]);

  const sourcesById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );

  function startNew() {
    setDraft(EMPTY_DRAFT);
    setPhrases("");
    setEditingId("new");
    setError(null);
  }

  function startEdit(rule: CaptureRule) {
    setDraft({
      name: rule.name,
      matchPhrases: rule.matchPhrases,
      instructions: rule.instructions,
      targetSourceId: rule.targetSourceId,
      pathPrefix: rule.pathPrefix,
      defaultSensitivity: rule.defaultSensitivity,
      enabled: rule.enabled,
    });
    setPhrases(phraseText(rule.matchPhrases));
    setEditingId(rule.id);
    setError(null);
  }

  async function persist(next: Draft, id: string | "new") {
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(
        id === "new"
          ? `${API_URL}/api/workspaces/${workspaceId}/knowledge/capture-rules`
          : `${API_URL}/api/workspaces/${workspaceId}/knowledge/capture-rules/${id}`,
        {
          method: id === "new" ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? copy.saveError);
      }
      setEditingId(null);
      await fetchRules();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.saveError);
    } finally {
      setSaving(false);
    }
  }

  async function saveEditor() {
    if (!editingId) return;
    const matchPhrases = parseCapturePhrases(phrases);
    if (!draft.name.trim() || matchPhrases.length === 0 || !draft.instructions.trim()) {
      setError(copy.requiredError);
      return;
    }
    await persist({ ...draft, matchPhrases }, editingId);
  }

  async function toggleRule(rule: CaptureRule) {
    if (!canManage || saving) return;
    await persist({
      name: rule.name,
      matchPhrases: rule.matchPhrases,
      instructions: rule.instructions,
      targetSourceId: rule.targetSourceId,
      pathPrefix: rule.pathPrefix,
      defaultSensitivity: rule.defaultSensitivity,
      enabled: !rule.enabled,
    }, rule.id);
  }

  async function removeRule(rule: CaptureRule) {
    if (!canManage || saving) return;
    const ok = await confirmDialog({
      description: format(copy.deleteConfirm, { name: rule.name }),
      confirmLabel: copy.deleteAction,
      cancelLabel: copy.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setSaving(true);
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${workspaceId}/knowledge/capture-rules/${rule.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(copy.deleteError);
      if (editingId === rule.id) setEditingId(null);
      await fetchRules();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.deleteError);
    } finally {
      setSaving(false);
    }
  }

  function destinationLabel(rule: CaptureRule): string {
    if (rule.targetSourceId === null) return copy.manualDestination;
    return sourcesById.get(rule.targetSourceId)?.repo ?? copy.missingDestination;
  }

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card/50 px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{copy.title}</h2>
            <span className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium",
              rules && rules.some((rule) => rule.enabled)
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground",
            )}>
              {rules && rules.some((rule) => rule.enabled) ? copy.onBadge : copy.offBadge}
            </span>
          </div>
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">{copy.intro}</p>
        </div>
        {canManage && editingId === null && (
          <button
            type="button"
            onClick={startNew}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
          >
            <Plus className="size-3.5" aria-hidden />
            {copy.addAction}
          </button>
        )}
      </div>

      {rules === null ? (
        <p className="text-xs text-muted-foreground">{copy.loading}</p>
      ) : rules.length === 0 && editingId === null ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
          {copy.empty}
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => (
            <div key={rule.id} className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
              <button
                type="button"
                role="switch"
                aria-checked={rule.enabled}
                aria-label={format(copy.toggleAria, { name: rule.name })}
                disabled={!canManage || saving}
                onClick={() => void toggleRule(rule)}
                className={cn(
                  "mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors disabled:opacity-50",
                  rule.enabled ? "bg-action" : "bg-muted-foreground/30",
                )}
              >
                <span className={cn(
                  "block size-4 rounded-full bg-background shadow-sm transition-transform",
                  rule.enabled && "translate-x-4",
                )} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium">{rule.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {destinationLabel(rule)}
                  </span>
                  {rule.pathPrefix && (
                    <span className="font-mono text-[10px] text-muted-foreground">{rule.pathPrefix}/</span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {format(copy.matchesLine, { phrases: rule.matchPhrases.join(", ") })}
                </p>
                <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{rule.instructions}</p>
              </div>
              {canManage && (
                <div className="flex shrink-0 items-center gap-1">
                  <button type="button" onClick={() => startEdit(rule)} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={format(copy.editAria, { name: rule.name })}>
                    <Pencil className="size-3.5" aria-hidden />
                  </button>
                  <button type="button" onClick={() => void removeRule(rule)} className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={format(copy.deleteAria, { name: rule.name })}>
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editingId !== null && (
        <div className="space-y-3 rounded-lg border border-border bg-background px-3 py-3">
          <h3 className="text-xs font-medium">{editingId === "new" ? copy.newTitle : copy.editTitle}</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="font-medium">{copy.nameLabel}</span>
              <input value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} maxLength={80} placeholder={copy.namePlaceholder} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 outline-none focus:ring-2 focus:ring-ring" />
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-medium">{copy.phrasesLabel}</span>
              <textarea value={phrases} onChange={(event) => setPhrases(event.target.value)} rows={2} placeholder={copy.phrasesPlaceholder} className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 outline-none focus:ring-2 focus:ring-ring" />
              <span className="block text-[10px] text-muted-foreground">{copy.phrasesHelp}</span>
            </label>
          </div>
          <label className="block space-y-1 text-xs">
            <span className="font-medium">{copy.instructionsLabel}</span>
            <textarea value={draft.instructions} onChange={(event) => setDraft((value) => ({ ...value, instructions: event.target.value }))} rows={3} maxLength={1000} placeholder={copy.instructionsPlaceholder} className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 outline-none focus:ring-2 focus:ring-ring" />
          </label>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1 text-xs">
              <span className="font-medium">{copy.destinationLabel}</span>
              <Select
                value={draft.targetSourceId ?? "manual"}
                onValueChange={(value) => setDraft((current) => ({ ...current, targetSourceId: value === "manual" ? null : value }))}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value="manual">{copy.manualDestination}</SelectItem>
                  {sources.map((source) => {
                    const writable = source.sourceType === "local" || source.writeAccess === true;
                    return (
                      <SelectItem key={source.id} value={source.id} disabled={!writable}>
                        {writable ? source.repo : format(copy.readOnlyDestination, { source: source.repo })}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <label className="space-y-1 text-xs">
              <span className="font-medium">{copy.pathLabel}</span>
              <input value={draft.pathPrefix} onChange={(event) => setDraft((value) => ({ ...value, pathPrefix: event.target.value }))} maxLength={240} placeholder={copy.pathPlaceholder} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 outline-none focus:ring-2 focus:ring-ring" />
            </label>
            <div className="space-y-1 text-xs">
              <span className="font-medium">{copy.sensitivityLabel}</span>
              <Select value={draft.defaultSensitivity} onValueChange={(value) => setDraft((current) => ({ ...current, defaultSensitivity: value as Sensitivity }))}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value="public">{tiers.public}</SelectItem>
                  <SelectItem value="internal">{tiers.internal}</SelectItem>
                  <SelectItem value="confidential">{tiers.confidential}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" disabled={saving} onClick={() => { setEditingId(null); setError(null); }} className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">{copy.cancel}</button>
            <button type="button" disabled={saving} onClick={() => void saveEditor()} className="rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-action-foreground hover:bg-action/90 disabled:opacity-50">{saving ? copy.saving : copy.save}</button>
          </div>
        </div>
      )}

      {!canManage && rules !== null && (
        <p className="text-[11px] text-muted-foreground">{copy.readOnlyNote}</p>
      )}
      {error && editingId === null && <p className="text-xs text-destructive">{error}</p>}
    </section>
  );
}
