"use client";

/**
 * Workspace Models section — the metered-profile manager (model-registry.md
 * L15, §4.4). Lists the workspace's saved metered profiles (named tool-round
 * budgets over metered models: `deepseek-v4-pro / quick` at 10 rounds beside
 * `/ deep` at 100), with create / rename / re-budget / delete. Each profile
 * row shows its pre-flight estimate at ITS budget, so `quick` and `deep`
 * visibly price differently before anyone picks them in chat.
 *
 * Metered models come from `/api/models/menu` — a model whose provider key
 * is absent at boot is absent here too (L12), and this section renders an
 * empty-state instead. Curated tiers have no per-class choice yet (one
 * Gemini default per class until a promotion verdict), so this section is
 * the metered lane only.
 *
 * Also hosts the workspace's BYO Gemini key block (hosted edition): every
 * model-related workspace setting lives in this one section. OSS keeps the
 * standalone `ws-llm-key` section instead (no Models section there).
 *
 * [COMP:app-web/models-settings]
 */

import { useCallback, useEffect, useState } from "react";
import { Gauge, Pencil, Plus, Trash2 } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  SearchableSelect,
  type SearchableSelectItem,
} from "@/components/ui/searchable-select";
import {
  clearWorkspaceModelDefault,
  createMeteredProfile,
  deleteMeteredProfile,
  fetchMeteredEstimate,
  fetchModelMenu,
  setWorkspaceModelDefault,
  updateMeteredProfile,
  type MenuModel,
  type MeteredEstimate,
  type MeteredProfile,
  type WorkspaceModelDefault,
} from "@/lib/api/models";
import { WorkspaceLlmKeyBlock } from "./llm-key-block";

const DEFAULTABLE_CLASSES: WorkspaceModelDefault["modelClass"][] = ["standard-pro", "max", "research"];

export function ModelsSection() {
  const t = useT().chrome.settingsModal.models;
  const { workspaceId } = useWorkspaceContext();
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<MenuModel[]>([]);
  const [menuClasses, setMenuClasses] = useState<Record<string, MenuModel[]>>({});
  const [defaults, setDefaults] = useState<WorkspaceModelDefault[]>([]);
  const [profiles, setProfiles] = useState<MeteredProfile[]>([]);
  const [billingAvailable, setBillingAvailable] = useState(false);
  const [estimates, setEstimates] = useState<Record<string, MeteredEstimate | null>>({});
  const [loading, setLoading] = useState(true);
  // Create form state.
  const [newModel, setNewModel] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [newRounds, setNewRounds] = useState(100);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const menu = await fetchModelMenu(workspaceId);
      const metered = menu.classes["metered"] ?? [];
      setModels(metered);
      setMenuClasses(menu.classes);
      setDefaults(menu.defaults ?? []);
      setProfiles(menu.profiles);
      setBillingAvailable(menu.meteredBillingAvailable);
      if (menu.meteredBillingAvailable) {
        const pairs = await Promise.all(
          menu.profiles.map(async (p) => [p.id, await fetchMeteredEstimate(workspaceId, p.modelAlias, p.toolRounds).catch(() => null)] as const),
        );
        setEstimates(Object.fromEntries(pairs));
      }
    } catch {
      setModels([]);
      setProfiles([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void reload(); }, [reload]);

  const clampRounds = (n: number) => Math.min(200, Math.max(10, Math.round(n) || 10));

  const onCreate = useCallback(async () => {
    if (!workspaceId || !newModel || !newName.trim()) return;
    setSaving(true);
    try {
      await createMeteredProfile(workspaceId, {
        name: newName.trim(),
        modelAlias: newModel,
        toolRounds: clampRounds(newRounds),
      });
      setNewName("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.saveError);
    } finally {
      setSaving(false);
    }
  }, [workspaceId, newModel, newName, newRounds, reload, t]);

  // Tier defaults (§4.4): "" = follow the registry, `a:<alias>` = curated
  // same-class pin, `p:<id>` = metered profile (picker prominence only; the
  // L8 estimate→confirm still gates every metered spend). Writes are
  // owner/admin server-side; a member's attempt surfaces the 403 inline.
  const onDefaultChange = useCallback(async (cls: WorkspaceModelDefault["modelClass"], value: string) => {
    if (!workspaceId) return;
    setError(null);
    try {
      if (!value) await clearWorkspaceModelDefault(workspaceId, cls);
      else if (value.startsWith("a:")) await setWorkspaceModelDefault(workspaceId, cls, { modelAlias: value.slice(2) });
      else if (value.startsWith("p:")) await setWorkspaceModelDefault(workspaceId, cls, { meteredProfileId: value.slice(2) });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.saveError);
    }
  }, [workspaceId, reload, t]);

  const onDelete = useCallback(async (profile: MeteredProfile) => {
    if (!workspaceId) return;
    const ok = await confirmDialog({
      title: t.deleteTitle,
      description: t.deleteBody.replace("{name}", `${profile.modelAlias} / ${profile.name}`),
      variant: "destructive",
      confirmLabel: t.deleteCta,
    });
    if (!ok) return;
    try {
      await deleteMeteredProfile(workspaceId, profile.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.saveError);
    }
  }, [workspaceId, reload, t]);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold">{t.title}</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{t.blurb}</p>
      </div>

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{error}</p>
      ) : null}

      {!loading ? (
        <div className="space-y-2.5 rounded-lg border border-border/70 p-3">
          <div>
            <div className="text-[12.5px] font-medium">{t.defaultsTitle}</div>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">{t.defaultsBlurb}</p>
            {models.length > 0 && profiles.length === 0 ? (
              <p className="mt-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-[11.5px] text-muted-foreground">
                {t.defaultsNoProfilesHint}
              </p>
            ) : null}
          </div>
          {DEFAULTABLE_CLASSES.map((cls) => {
            const curated = menuClasses[cls] ?? [];
            const current = defaults.find((d) => d.modelClass === cls);
            const value = current?.meteredProfileId
              ? `p:${current.meteredProfileId}`
              : current?.modelAlias
                ? `a:${current.modelAlias}`
                : "";
            const classLabel =
              cls === "standard-pro" ? t.classStandardPro : cls === "max" ? t.classMax : t.classResearch;
            const registryLabel = t.registryDefault.replace("{alias}", curated[0]?.alias ?? "");
            // A pin option only exists for a model that genuinely differs
            // from the registry default (and from other pins) by wire id —
            // standard-pro's two aliases are the standard/pro billing labels
            // of ONE model, so they collapse into the registry-default entry
            // instead of posing as choices. Pins appear the day a promotion
            // adds a second real model to the class.
            const seenWire = new Set(curated[0] ? [curated[0].apiModelId] : []);
            const pins = curated.slice(1).filter((m) => {
              if (seenWire.has(m.apiModelId)) return false;
              seenWire.add(m.apiModelId);
              return true;
            });
            const items: SearchableSelectItem[] = [
              { value: "", label: registryLabel },
              ...pins.map((m) => ({ value: `a:${m.alias}`, label: m.alias })),
              ...profiles.map((p) => ({
                value: `p:${p.id}`,
                label: `${p.modelAlias} / ${p.name}`,
                hint: t.roundsLabel.replace("{rounds}", String(p.toolRounds)),
              })),
            ];
            return (
              <div key={cls} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-[12.5px]">{classLabel}</span>
                <SearchableSelect
                  value={value}
                  onValueChange={(v) => void onDefaultChange(cls, v)}
                  items={items}
                  placeholder={registryLabel}
                  className="flex-1"
                  aria-label={classLabel}
                />
              </div>
            );
          })}
        </div>
      ) : null}

      {loading ? (
        <p className="text-[12.5px] text-muted-foreground">{t.loading}</p>
      ) : models.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-[12.5px] text-muted-foreground">
          {t.empty}
        </p>
      ) : (
        <>
          <div className="pt-1">
            <div className="text-[12.5px] font-medium">{t.profilesTitle}</div>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">{t.profilesBlurb}</p>
          </div>
          <ul className="space-y-2">
            {profiles.map((p) => {
              const est = estimates[p.id];
              return (
                <li key={p.id} className="flex items-center gap-3 rounded-lg border border-border/70 px-3 py-2.5">
                  <Gauge className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">
                      {p.modelAlias} / {p.name}
                    </div>
                    <div className="text-[11.5px] text-muted-foreground">
                      {t.roundsLabel.replace("{rounds}", String(p.toolRounds))}
                      {billingAvailable && est
                        ? ` · ${t.estimateLabel.replace("{min}", String(est.minCredits)).replace("{max}", String(est.maxCredits))}`
                        : ""}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t.renameCta}
                    onClick={() => {
                      void (async () => {
                        if (!workspaceId) return;
                        const value = await promptDialog({
                          title: t.renameTitle,
                          description: t.renameBody.replace("{name}", `${p.modelAlias} / ${p.name}`),
                          defaultValue: p.name,
                          confirmLabel: t.renameCta,
                        });
                        if (!value || !value.trim() || value.trim() === p.name) return;
                        try {
                          await updateMeteredProfile(workspaceId, p.id, { name: value.trim().slice(0, 60) });
                          await reload();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : t.saveError);
                        }
                      })();
                    }}
                  >
                    <Pencil className="size-3.5" aria-hidden />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={t.deleteCta} onClick={() => void onDelete(p)}>
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </li>
              );
            })}
            {profiles.length === 0 ? (
              <li className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-[12.5px] text-muted-foreground">
                {t.noProfiles}
              </li>
            ) : null}
          </ul>

          <div className="rounded-lg border border-border/70 p-3">
            <div className="mb-2 text-[12.5px] font-medium">{t.createTitle}</div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={newModel} onValueChange={(v) => { if (v) setNewModel(v); }}>
                <SelectTrigger size="sm" aria-label={t.modelLabel} className="min-w-40 text-xs">
                  <span>{newModel || t.modelPlaceholder}</span>
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.alias} value={m.alias}>{m.alias}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t.namePlaceholder}
                maxLength={60}
                className="w-36 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px]"
              />
              <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                {t.roundsInputLabel}
                <input
                  type="number"
                  min={10}
                  max={200}
                  value={newRounds}
                  onChange={(e) => setNewRounds(Number(e.target.value))}
                  className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-[12.5px] tabular-nums"
                />
              </label>
              <Button size="sm" disabled={saving || !newModel || !newName.trim()} onClick={() => void onCreate()}>
                <Plus className="mr-1 size-3.5" aria-hidden />
                {t.createCta}
              </Button>
            </div>
            <p className="mt-2 text-[11.5px] text-muted-foreground">{t.createHint}</p>
          </div>
        </>
      )}

      <WorkspaceLlmKeyBlock />
    </div>
  );
}
