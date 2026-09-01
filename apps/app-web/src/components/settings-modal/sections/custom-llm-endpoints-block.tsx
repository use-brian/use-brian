"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Server, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import { useWorkspaceContext } from "@/lib/workspace-context";
import {
  createCustomLlmEndpoint,
  CustomLlmEndpointsUnavailableError,
  deleteCustomLlmEndpoint,
  listCustomLlmEndpoints,
  setCustomLlmFallbackPolicy,
  type CustomLlmEndpoint,
} from "@/lib/api/custom-llm-endpoints";

const inputClass = "w-full rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm outline-none";

export function CustomLlmEndpointsBlock({
  onChanged,
  embedded = false,
}: {
  onChanged?: () => void | Promise<void>;
  embedded?: boolean;
} = {}) {
  const t = useT().customLlmEndpoints;
  const { workspaceId } = useWorkspaceContext();
  const [endpoints, setEndpoints] = useState<CustomLlmEndpoint[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [fallbackSaving, setFallbackSaving] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [contextWindow, setContextWindow] = useState(32768);
  const [maxOutputTokens, setMaxOutputTokens] = useState(4096);

  const reload = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setEndpoints(await listCustomLlmEndpoints(workspaceId));
      setAvailable(true);
    } catch (err) {
      if (err instanceof CustomLlmEndpointsUnavailableError) setAvailable(false);
      else setError(err instanceof Error ? err.message : t.loadFailed);
    }
  }, [workspaceId, t.loadFailed]);

  useEffect(() => { void reload(); }, [reload]);

  if (available === false) return null;

  const save = async () => {
    if (!workspaceId || !name.trim() || !baseUrl.trim() || !modelId.trim()) return;
    setSaving(true);
    setError("");
    try {
      await createCustomLlmEndpoint(workspaceId, {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || null,
        modelId: modelId.trim(),
        contextWindow,
        maxOutputTokens,
      });
      setName("");
      setBaseUrl("");
      setApiKey("");
      setModelId("");
      setShowAddForm(false);
      await reload();
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={embedded ? "space-y-4" : "mt-6 space-y-4 border-t border-border pt-6"}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">{t.heading}</h3>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{t.description}</p>
        </div>
        {available ? (
          <Button variant="outline" size="sm" onClick={() => setShowAddForm((current) => !current)}>
            <Plus className="mr-1 size-3.5" aria-hidden />
            {showAddForm ? t.cancelCta : t.addTitle}
          </Button>
        ) : null}
      </div>

      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{error}</p> : null}

      {available === null ? (
        <p className="text-[12px] text-muted-foreground">{t.loading}</p>
      ) : (
        <>
          <ul className="space-y-2">
            {endpoints.map((endpoint) => (
              <li key={endpoint.id} className="rounded-lg border border-border/70 px-3 py-2.5">
                <div className="flex items-center gap-3">
                <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{endpoint.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {(endpoint.profiles.length === 1 ? t.profileCountOne : t.profileCount)
                      .replace("{count}", String(endpoint.profiles.length))} · {endpoint.baseUrl}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t.deleteCta}
                  onClick={() => void (async () => {
                    if (!workspaceId) return;
                    const ok = await confirmDialog({
                      title: t.deleteTitle,
                      description: t.deleteBody.replace("{name}", endpoint.name),
                      confirmLabel: t.deleteCta,
                      variant: "destructive",
                    });
                    if (!ok) return;
                    await deleteCustomLlmEndpoint(workspaceId, endpoint.id);
                    await reload();
                    await onChanged?.();
                  })().catch((err) => setError(err instanceof Error ? err.message : t.saveFailed))}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
                </div>
                <div className="mt-2.5 flex items-start justify-between gap-3 border-t border-border/60 pt-2.5">
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium">{t.fallbackTitle}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{t.fallbackDesc}</div>
                  </div>
                  <Switch
                    checked={endpoint.fallbackToDefaultOnFailure}
                    disabled={fallbackSaving === endpoint.id}
                    aria-label={t.fallbackTitle}
                    onCheckedChange={(next) => void (async () => {
                      if (!workspaceId) return;
                      setFallbackSaving(endpoint.id);
                      setError("");
                      try {
                        await setCustomLlmFallbackPolicy(workspaceId, endpoint.id, next);
                        await reload();
                        await onChanged?.();
                      } finally {
                        setFallbackSaving(null);
                      }
                    })().catch((err) => setError(err instanceof Error ? err.message : t.saveFailed))}
                  />
                </div>
              </li>
            ))}
            {endpoints.length === 0 ? (
              <li className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-[12px] text-muted-foreground">{t.empty}</li>
            ) : null}
          </ul>

          {showAddForm ? <div className="space-y-3 rounded-lg border border-border/70 bg-muted/15 p-3">
            <div className="text-[12.5px] font-medium">{t.addTitle}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={t.namePlaceholder} maxLength={80} />
              <input className={inputClass} value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder={t.modelPlaceholder} maxLength={200} spellCheck={false} />
              <input className={`${inputClass} sm:col-span-2`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={t.urlPlaceholder} spellCheck={false} />
              <input className={`${inputClass} sm:col-span-2`} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={t.keyPlaceholder} autoComplete="off" spellCheck={false} />
              <label className="space-y-1 text-[11.5px] text-muted-foreground">
                {t.contextLabel}
                <input className={inputClass} type="number" min={1024} max={4000000} value={contextWindow} onChange={(e) => setContextWindow(Number(e.target.value))} />
              </label>
              <label className="space-y-1 text-[11.5px] text-muted-foreground">
                {t.outputLabel}
                <input className={inputClass} type="number" min={64} max={262144} value={maxOutputTokens} onChange={(e) => setMaxOutputTokens(Number(e.target.value))} />
              </label>
            </div>
            <Button onClick={() => void save()} disabled={saving || !name.trim() || !baseUrl.trim() || !modelId.trim()}>
              {saving ? t.testing : t.testAndSave}
            </Button>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t.connectionHint}</p>
          </div> : null}
        </>
      )}
    </div>
  );
}
