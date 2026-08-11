"use client";

/**
 * Workspace Models section (model-registry.md L15, §4.4). The page is split
 * by user intent: Routing shows the four runtime tier assignments, Custom
 * models owns OpenAI-compatible connections and their verified profiles, and
 * Advanced contains picker preferences, metered profiles, and the hosted
 * Gemini key. Creation forms stay collapsed until explicitly requested.
 *
 * The two kinds of defaults remain deliberately separate. Custom tier
 * assignments change what serves a Brian tier at runtime; model-menu defaults
 * only pin or highlight choices in the member picker.
 *
 * [COMP:app-web/models-settings]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Gauge, Layers3, Pencil, Plus, Trash2 } from "lucide-react";
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
import {
  clearCustomLlmTierDefault,
  createCustomLlmProfile,
  deleteCustomLlmProfile,
  getCustomLlmConfiguration,
  setCustomLlmTierDefault,
  type CustomLlmEndpoint,
  type CustomLlmProfile,
  type CustomLlmTier,
  type CustomLlmTierDefault,
} from "@/lib/api/custom-llm-endpoints";
import { CustomLlmEndpointsBlock } from "./custom-llm-endpoints-block";
import { WorkspaceLlmKeyBlock } from "./llm-key-block";

const DEFAULTABLE_CLASSES: WorkspaceModelDefault["modelClass"][] = ["standard-pro", "max", "research"];
const CUSTOM_TIERS: CustomLlmTier[] = ["standard", "pro", "max", "research"];
type ModelsView = "routing" | "custom" | "advanced";

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
  const [customEndpoints, setCustomEndpoints] = useState<CustomLlmEndpoint[]>([]);
  const [customTierDefaults, setCustomTierDefaults] = useState<CustomLlmTierDefault[]>([]);
  const [loading, setLoading] = useState(true);
  // Create form state.
  const [newModel, setNewModel] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [newRounds, setNewRounds] = useState(100);
  const [newCustomEndpointId, setNewCustomEndpointId] = useState("");
  const [newCustomName, setNewCustomName] = useState("");
  const [newCustomModelId, setNewCustomModelId] = useState("");
  const [newCustomContextWindow, setNewCustomContextWindow] = useState(32768);
  const [newCustomMaxOutput, setNewCustomMaxOutput] = useState(4096);
  const [customSaving, setCustomSaving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeView, setActiveView] = useState<ModelsView>("routing");
  const [showCustomCreate, setShowCustomCreate] = useState(false);
  const [showMeteredCreate, setShowMeteredCreate] = useState(false);

  const reload = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const [menu, custom] = await Promise.all([
        fetchModelMenu(workspaceId),
        getCustomLlmConfiguration(workspaceId),
      ]);
      const metered = menu.classes["metered"] ?? [];
      setModels(metered);
      setMenuClasses(menu.classes);
      setDefaults(menu.defaults ?? []);
      setProfiles(menu.profiles);
      setCustomEndpoints(custom.endpoints);
      setCustomTierDefaults(custom.tierDefaults);
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
      setCustomEndpoints([]);
      setCustomTierDefaults([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!newCustomEndpointId && customEndpoints[0]) setNewCustomEndpointId(customEndpoints[0].id);
  }, [customEndpoints, newCustomEndpointId]);

  const clampRounds = (n: number) => Math.min(200, Math.max(10, Math.round(n) || 10));

  // Alias -> human product name, from the served menu (registry displayName).
  // Profiles store aliases; every label a user reads prefers the real name.
  const displayNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const list of Object.values(menuClasses)) for (const m of list) map.set(m.alias, m.displayName);
    return map;
  }, [menuClasses]);
  const nameFor = useCallback((alias: string) => displayNames.get(alias) ?? alias, [displayNames]);

  const customProfiles = useMemo(
    () => customEndpoints.flatMap((endpoint) =>
      endpoint.profiles.map((profile) => ({ endpoint, profile }))),
    [customEndpoints],
  );

  const customProfileLabel = useCallback((endpoint: CustomLlmEndpoint, profile: CustomLlmProfile) =>
    `${endpoint.name} / ${profile.name === endpoint.name ? profile.modelId : profile.name}`,
  []);

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
      setShowMeteredCreate(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.saveError);
    } finally {
      setSaving(false);
    }
  }, [workspaceId, newModel, newName, newRounds, reload, t]);

  const onCreateCustomProfile = useCallback(async () => {
    if (!workspaceId || !newCustomEndpointId || !newCustomName.trim() || !newCustomModelId.trim()) return;
    setCustomSaving(true);
    setError(null);
    try {
      await createCustomLlmProfile(workspaceId, newCustomEndpointId, {
        name: newCustomName.trim(),
        modelId: newCustomModelId.trim(),
        contextWindow: newCustomContextWindow,
        maxOutputTokens: newCustomMaxOutput,
      });
      setNewCustomName("");
      setNewCustomModelId("");
      setShowCustomCreate(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.saveError);
    } finally {
      setCustomSaving(false);
    }
  }, [workspaceId, newCustomEndpointId, newCustomName, newCustomModelId, newCustomContextWindow, newCustomMaxOutput, reload, t]);

  const onCustomTierChange = useCallback(async (tier: CustomLlmTier, value: string) => {
    if (!workspaceId) return;
    setError(null);
    try {
      if (!value || value === "managed") await clearCustomLlmTierDefault(workspaceId, tier);
      else await setCustomLlmTierDefault(workspaceId, tier, value);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.saveError);
    }
  }, [workspaceId, reload, t]);

  const onDeleteCustomProfile = useCallback(async (endpoint: CustomLlmEndpoint, profile: CustomLlmProfile) => {
    if (!workspaceId) return;
    const label = customProfileLabel(endpoint, profile);
    const ok = await confirmDialog({
      title: t.customDeleteTitle,
      description: t.customDeleteBody.replace("{name}", label),
      variant: "destructive",
      confirmLabel: t.deleteCta,
    });
    if (!ok) return;
    try {
      await deleteCustomLlmProfile(workspaceId, endpoint.id, profile.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.saveError);
    }
  }, [workspaceId, customProfileLabel, reload, t]);

  // Tier defaults (§4.4): "registry" = follow the registry (row deleted),
  // `a:<alias>` = curated same-class pin, `p:<id>` = metered profile (picker
  // prominence only; the L8 estimate→confirm still gates every metered
  // spend). Writes are owner/admin server-side; a member's attempt surfaces
  // the 403 inline.
  const onDefaultChange = useCallback(async (cls: WorkspaceModelDefault["modelClass"], value: string) => {
    if (!workspaceId) return;
    setError(null);
    try {
      if (!value || value === "registry") await clearWorkspaceModelDefault(workspaceId, cls);
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
      description: t.deleteBody.replace("{name}", `${nameFor(profile.modelAlias)} / ${profile.name}`),
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

      <div role="tablist" aria-label={t.viewsLabel} className="grid grid-cols-3 gap-1 rounded-xl bg-muted/55 p-1">
        {(["routing", "custom", "advanced"] as ModelsView[]).map((view) => {
          const label = view === "routing" ? t.viewRouting : view === "custom" ? t.viewCustom : t.viewAdvanced;
          const selected = activeView === view;
          return (
            <button
              key={view}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActiveView(view)}
              className={`rounded-lg px-3 py-2 text-[12.5px] font-medium transition-colors ${selected
                ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
                : "text-muted-foreground hover:bg-background/50 hover:text-foreground"}`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{error}</p>
      ) : null}

      {activeView === "routing" ? (
        loading ? (
          <p className="text-[12.5px] text-muted-foreground">{t.loading}</p>
        ) : (
          <section className="space-y-4" role="tabpanel">
            <div>
              <div className="text-[13px] font-medium">{t.customRoutingTitle}</div>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{t.customRoutingBlurb}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {CUSTOM_TIERS.map((tier) => {
                const current = customTierDefaults.find((setting) => setting.tier === tier);
                const tierLabel = tier === "standard"
                  ? t.classStandard
                  : tier === "pro"
                    ? t.classPro
                    : tier === "max"
                      ? t.classMax
                      : t.classResearch;
                const items: SearchableSelectItem[] = [
                  { value: "managed", label: t.brianManaged, badge: t.defaultBadge },
                  ...customProfiles.map(({ endpoint, profile }) => ({
                    value: profile.id,
                    label: customProfileLabel(endpoint, profile),
                    hint: profile.modelId,
                  })),
                ];
                return (
                  <div key={tier} className="space-y-2 rounded-xl border border-border/70 bg-muted/15 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12.5px] font-medium">{tierLabel}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                        {current ? t.viewCustom : t.brianManaged}
                      </span>
                    </div>
                    <SearchableSelect
                      value={current?.profileId ?? "managed"}
                      onValueChange={(value) => void onCustomTierChange(tier, value)}
                      items={items}
                      placeholder={t.brianManaged}
                      aria-label={tierLabel}
                    />
                  </div>
                );
              })}
            </div>
            {customProfiles.length === 0 ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-border px-3.5 py-3">
                <p className="text-[11.5px] text-muted-foreground">{t.noCustomProfiles}</p>
                <Button variant="outline" size="sm" onClick={() => setActiveView("custom")}>{t.routingEmptyCta}</Button>
              </div>
            ) : null}
          </section>
        )
      ) : null}

      {activeView === "custom" ? (
        loading ? (
          <p className="text-[12.5px] text-muted-foreground">{t.loading}</p>
        ) : (
          <div className="space-y-4" role="tabpanel">
            <section className="rounded-xl border border-border/70 p-4">
              <CustomLlmEndpointsBlock embedded onChanged={reload} />
            </section>

            <section className="space-y-3 rounded-xl border border-border/70 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-medium">{t.customProfilesTitle}</div>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{t.customProfilesBlurb}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={customEndpoints.length === 0}
                  onClick={() => setShowCustomCreate((current) => !current)}
                >
                  <Plus className="mr-1 size-3.5" aria-hidden />
                  {showCustomCreate ? t.cancelCreateCta : t.addProfileCta}
                </Button>
              </div>

              <ul className="space-y-2">
                {customProfiles.map(({ endpoint, profile }) => {
                  const assigned = customTierDefaults
                    .filter((setting) => setting.profileId === profile.id)
                    .map((setting) => setting.tier === "standard"
                      ? t.classStandard
                      : setting.tier === "pro"
                        ? t.classPro
                        : setting.tier === "max"
                          ? t.classMax
                          : t.classResearch);
                  return (
                    <li key={profile.id} className="flex items-center gap-3 rounded-lg bg-muted/25 px-3 py-2.5">
                      <Layers3 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium">{customProfileLabel(endpoint, profile)}</div>
                        <div className="truncate text-[11.5px] text-muted-foreground">
                          {profile.modelId}
                          {assigned.length > 0 ? ` · ${t.assignedTo.replace("{tiers}", assigned.join(", "))}` : ""}
                        </div>
                      </div>
                      <Button variant="ghost" size="icon" aria-label={t.deleteCta} onClick={() => void onDeleteCustomProfile(endpoint, profile)}>
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </li>
                  );
                })}
                {customProfiles.length === 0 ? (
                  <li className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-[12.5px] text-muted-foreground">
                    {t.noCustomProfiles}
                  </li>
                ) : null}
              </ul>

              {showCustomCreate ? (
                <div className="space-y-3 rounded-lg bg-muted/20 p-3">
                  <div className="text-[12.5px] font-medium">{t.customCreateTitle}</div>
                  {customEndpoints.length === 0 ? (
                    <p className="text-[11.5px] text-muted-foreground">{t.customCreateNeedsEndpoint}</p>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Select value={newCustomEndpointId} onValueChange={(value) => { if (value) setNewCustomEndpointId(value); }}>
                        <SelectTrigger size="sm" aria-label={t.endpointLabel} className="text-xs">
                          <span>{customEndpoints.find((endpoint) => endpoint.id === newCustomEndpointId)?.name ?? t.endpointPlaceholder}</span>
                        </SelectTrigger>
                        <SelectContent>
                          {customEndpoints.map((endpoint) => (
                            <SelectItem key={endpoint.id} value={endpoint.id}>{endpoint.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <input value={newCustomName} onChange={(event) => setNewCustomName(event.target.value)} placeholder={t.customNamePlaceholder} maxLength={80} className="rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px]" />
                      <input value={newCustomModelId} onChange={(event) => setNewCustomModelId(event.target.value)} placeholder={t.customModelPlaceholder} maxLength={200} spellCheck={false} className="rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] sm:col-span-2" />
                      <label className="space-y-1 text-[11.5px] text-muted-foreground">
                        {t.contextLabel}
                        <input type="number" min={1024} max={4000000} value={newCustomContextWindow} onChange={(event) => setNewCustomContextWindow(Number(event.target.value))} className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px]" />
                      </label>
                      <label className="space-y-1 text-[11.5px] text-muted-foreground">
                        {t.outputLabel}
                        <input type="number" min={64} max={262144} value={newCustomMaxOutput} onChange={(event) => setNewCustomMaxOutput(Number(event.target.value))} className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px]" />
                      </label>
                      <div className="sm:col-span-2">
                        <Button size="sm" disabled={customSaving || !newCustomEndpointId || !newCustomName.trim() || !newCustomModelId.trim()} onClick={() => void onCreateCustomProfile()}>
                          <Plus className="mr-1 size-3.5" aria-hidden />
                          {customSaving ? t.testingProfile : t.createProfileCta}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </section>
          </div>
        )
      ) : null}

      {activeView === "advanced" ? (
        <div className="space-y-4" role="tabpanel">
          {!loading ? (
            <section className="space-y-2.5 rounded-xl border border-border/70 p-4">
              <div>
                <div className="text-[13px] font-medium">{t.defaultsTitle}</div>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{t.defaultsBlurb}</p>
                {models.length > 0 && profiles.length === 0 ? (
                  <p className="mt-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-[11.5px] text-muted-foreground">{t.defaultsNoProfilesHint}</p>
                ) : null}
              </div>
              {DEFAULTABLE_CLASSES.map((cls) => {
                const curated = menuClasses[cls] ?? [];
                const current = defaults.find((d) => d.modelClass === cls);
                const value = current?.meteredProfileId ? `p:${current.meteredProfileId}` : current?.modelAlias ? `a:${current.modelAlias}` : "registry";
                const classLabel = cls === "standard-pro" ? t.classStandardPro : cls === "max" ? t.classMax : t.classResearch;
                const registryLabel = curated[0]?.displayName ?? "";
                const seenWire = new Set(curated[0] ? [curated[0].apiModelId] : []);
                const pins = curated.slice(1).filter((model) => {
                  if (seenWire.has(model.apiModelId)) return false;
                  seenWire.add(model.apiModelId);
                  return true;
                });
                const items: SearchableSelectItem[] = [
                  { value: "registry", label: registryLabel, badge: t.defaultBadge },
                  ...pins.map((model) => ({ value: `a:${model.alias}`, label: model.displayName })),
                  ...profiles.map((profile) => ({
                    value: `p:${profile.id}`,
                    label: `${nameFor(profile.modelAlias)} / ${profile.name}`,
                    hint: t.roundsLabel.replace("{rounds}", String(profile.toolRounds)),
                  })),
                ];
                return (
                  <div key={cls} className="flex items-center gap-3">
                    <span className="w-28 shrink-0 text-[12.5px]">{classLabel}</span>
                    <SearchableSelect value={value} onValueChange={(next) => void onDefaultChange(cls, next)} items={items} placeholder={registryLabel} className="flex-1" aria-label={classLabel} />
                  </div>
                );
              })}
            </section>
          ) : null}

          {loading ? (
            <p className="text-[12.5px] text-muted-foreground">{t.loading}</p>
          ) : models.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 px-3 py-4 text-[12.5px] text-muted-foreground">{t.empty}</p>
          ) : (
            <section className="space-y-3 rounded-xl border border-border/70 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-medium">{t.profilesTitle}</div>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{t.profilesBlurb}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setShowMeteredCreate((current) => !current)}>
                  <Plus className="mr-1 size-3.5" aria-hidden />
                  {showMeteredCreate ? t.cancelCreateCta : t.addProfileCta}
                </Button>
              </div>
              <ul className="space-y-2">
                {profiles.map((profile) => {
                  const estimate = estimates[profile.id];
                  return (
                    <li key={profile.id} className="flex items-center gap-3 rounded-lg bg-muted/25 px-3 py-2.5">
                      <Gauge className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium">{nameFor(profile.modelAlias)} / {profile.name}</div>
                        <div className="text-[11.5px] text-muted-foreground">
                          {t.roundsLabel.replace("{rounds}", String(profile.toolRounds))}
                          {billingAvailable && estimate ? ` · ${t.estimateLabel.replace("{min}", String(estimate.minCredits)).replace("{max}", String(estimate.maxCredits))}` : ""}
                        </div>
                      </div>
                      <Button variant="ghost" size="icon" aria-label={t.renameCta} onClick={() => {
                        void (async () => {
                          if (!workspaceId) return;
                          const value = await promptDialog({ title: t.renameTitle, description: t.renameBody.replace("{name}", `${nameFor(profile.modelAlias)} / ${profile.name}`), defaultValue: profile.name, confirmLabel: t.renameCta });
                          if (!value || !value.trim() || value.trim() === profile.name) return;
                          try {
                            await updateMeteredProfile(workspaceId, profile.id, { name: value.trim().slice(0, 60) });
                            await reload();
                          } catch (err) {
                            setError(err instanceof Error ? err.message : t.saveError);
                          }
                        })();
                      }}>
                        <Pencil className="size-3.5" aria-hidden />
                      </Button>
                      <Button variant="ghost" size="icon" aria-label={t.deleteCta} onClick={() => void onDelete(profile)}>
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </li>
                  );
                })}
                {profiles.length === 0 ? (
                  <li className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-[12.5px] text-muted-foreground">{t.noProfiles}</li>
                ) : null}
              </ul>
              {showMeteredCreate ? (
                <div className="space-y-3 rounded-lg bg-muted/20 p-3">
                  <div className="text-[12.5px] font-medium">{t.createTitle}</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select value={newModel} onValueChange={(value) => { if (value) setNewModel(value); }}>
                      <SelectTrigger size="sm" aria-label={t.modelLabel} className="min-w-40 text-xs"><span>{newModel ? nameFor(newModel) : t.modelPlaceholder}</span></SelectTrigger>
                      <SelectContent>{models.map((model) => <SelectItem key={model.alias} value={model.alias}>{model.displayName}</SelectItem>)}</SelectContent>
                    </Select>
                    <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder={t.namePlaceholder} maxLength={60} className="w-36 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px]" />
                    <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                      {t.roundsInputLabel}
                      <input type="number" min={10} max={200} value={newRounds} onChange={(event) => setNewRounds(Number(event.target.value))} className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-[12.5px] tabular-nums" />
                    </label>
                    <Button size="sm" disabled={saving || !newModel || !newName.trim()} onClick={() => void onCreate()}>
                      <Plus className="mr-1 size-3.5" aria-hidden />{t.createCta}
                    </Button>
                  </div>
                  <p className="text-[11.5px] text-muted-foreground">{t.createHint}</p>
                </div>
              ) : null}
            </section>
          )}

          <section className="rounded-xl border border-border/70 p-4">
            <WorkspaceLlmKeyBlock embedded showCustomEndpoints={false} />
          </section>
        </div>
      ) : null}
    </div>
  );
}
