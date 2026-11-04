"use client";

/** Capture setup and profile management. [COMP:app-web/studio-programmatic-access] */
import Link from "next/link";
import { useState } from "react";
import { ChevronDown, Database, Plus, Trash2 } from "lucide-react";
import { ProgrammaticAccessShell } from "@/components/studio/programmatic-access-shell";
import { CapturePreset, CaptureSetup, PendingCaptureRecovery } from "@/components/engineering-history/capture-preset";
import { useWorkspaces } from "@/contexts/workspace-context";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";
import { invalidateSurfaceCache } from "@/lib/surface-cache";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RailSurfaceSkeleton } from "@/components/chrome/surface-skeleton";
import type { ContextProject, ContextTeam } from "@/lib/api/context-scopes";
import type { StudioAssistantSummary } from "@/lib/api/studio";
import { useBrainKeysData } from "../use-brain-keys-data";
import {
  addCaptureRule,
  createCaptureProfile,
  deleteCaptureProfile,
  deleteCaptureRule,
  listCaptureProfiles,
  setAssistantCaptureProfile,
  updateCaptureProfile,
  type CaptureFilterType,
  type CapturePartition,
  type CaptureProfile,
  type CaptureRoutingMode,
} from "@/lib/api/programmatic-capture";

const CAPTURE_NONE = "capture-none";

export default function CapturePage() {
  const { activeId } = useWorkspaces();
  return <ProgrammaticAccessShell active="capture"><CaptureContent key={activeId} /></ProgrammaticAccessShell>;
}

function CaptureContent() {
  const t = useT();
  const { activeId } = useWorkspaces();
  const { data, adminOnly, error: loadError, update } = useBrainKeysData(activeId);
  const [actionError, setError] = useState<string | null>(null);
  const error = actionError ?? loadError;
  const cold = data === undefined && !adminOnly && !loadError;
  return <div className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-prose text-sm text-muted-foreground">{t.programmaticAccess.navigation.captureHint}</p>
      {activeId && <Link className="inline-flex min-h-8 max-sm:min-h-11 items-center rounded-md px-3 text-sm font-medium underline underline-offset-4 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" href={`/w/${activeId}/studio/programmatic-access/history`}>{t.engineeringHistory.open}</Link>}
    </header>
    {error && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    {adminOnly && <p className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">{t.programmaticAccess.navigation.captureAdminOnly}</p>}
    {cold && <RailSurfaceSkeleton chrome={false} padded={false} rows={4} />}
    {!adminOnly && data && activeId && <CaptureProfilesSection
      workspaceId={activeId} assistants={data.assistants} teams={data.teams} projects={data.projects}
      profiles={data.captureProfiles} onProfilesChange={profiles => update(prev => ({ ...prev, captureProfiles: profiles }))} onError={setError}
    />}
    <CaptureSetup />
    {activeId && <PendingCaptureRecovery workspaceId={activeId} />}
  </div>;
}

function CaptureProfilesSection({
  workspaceId,
  assistants,
  teams,
  projects,
  profiles,
  onProfilesChange,
  onError,
}: {
  workspaceId: string;
  assistants: StudioAssistantSummary[];
  teams: ContextTeam[];
  projects: ContextProject[];
  profiles: CaptureProfile[];
  onProfilesChange: (profiles: CaptureProfile[]) => void;
  onError: (error: string | null) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [partitionBy, setPartitionBy] = useState<CapturePartition>("session");
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [purpose, setPurpose] = useState("archive_only");

  async function refresh() {
    onProfilesChange(await listCaptureProfiles(workspaceId));
  }

  async function run(operation: () => Promise<void>) {
    setSaving(true);
    onError(null);
    try {
      await operation();
      await refresh();
      invalidateSurfaceCache(`engineering-history:${workspaceId}`);
    } catch (err) {
      onError((err as Error).message==="capture_pending_archive_review_required"?t.engineeringHistory.pendingReview:(err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const partitionItems = {
    connection: t.programmaticAccess.capture.partitionConnection,
    user: t.programmaticAccess.capture.partitionUser,
    session: t.programmaticAccess.capture.partitionSession,
    subject: t.programmaticAccess.capture.partitionSubject,
  };
  const profileItems = Object.fromEntries([
    [CAPTURE_NONE, t.programmaticAccess.capture.noDefault],
    ...profiles.map((profile) => [profile.id, profile.name]),
  ]);

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
        <h2 className="text-[13px] font-semibold tracking-tight uppercase text-muted-foreground">
          {t.programmaticAccess.capture.title}
        </h2>
        <p className="text-[13px] text-muted-foreground mt-1 max-w-2xl">
          {t.programmaticAccess.capture.description}
        </p>
        </div>
        <Button className="min-h-8 max-sm:min-h-11" onClick={() => setCreating(value => !value)} aria-expanded={creating} aria-controls="capture-create">
          {creating ? t.programmaticAccess.create.cancel : t.programmaticAccess.capture.createProfile}
        </Button>
      </header>

      {creating && <div id="capture-create" className="space-y-3">
        <label className="grid gap-2 text-sm font-medium">
          {t.engineeringHistory.purpose}
          <Select value={purpose} items={{ archive_only: t.programmaticAccess.navigation.archive, extract: t.engineeringHistory.extract }} onValueChange={value => value && setPurpose(value)} disabled={saving}>
            <SelectTrigger className="min-h-8 max-sm:min-h-11" aria-label={t.engineeringHistory.purpose}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="archive_only">{t.programmaticAccess.navigation.archive}</SelectItem>
              <SelectItem value="extract">{t.engineeringHistory.extract}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <p className="text-sm text-muted-foreground">{purpose === "archive_only" ? t.programmaticAccess.navigation.archiveHint : t.programmaticAccess.navigation.extractHint}</p>
        {purpose === "archive_only" ? <CapturePreset workspaceId={workspaceId} teams={teams} projects={projects} onCreated={refresh} onError={onError} onDone={() => setCreating(false)} /> : <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_180px_auto]">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label={t.engineeringHistory.name}
            placeholder={t.programmaticAccess.capture.profileNamePlaceholder}
            maxLength={120}
            className="bg-muted/50 border border-border rounded-lg px-3 py-2 text-[16px] md:text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <Select value={partitionBy} items={partitionItems} onValueChange={(value) => value && setPartitionBy(value as CapturePartition)}>
            <SelectTrigger aria-label={t.programmaticAccess.capture.partitionLabel}><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(partitionItems).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            disabled={!name.trim() || saving}
            onClick={() => run(async () => {
              await createCaptureProfile(workspaceId, { name: name.trim(), partitionBy, enabled: true });
              setName("");
              setCreating(false);
            })}
          >
            <Plus className="h-3.5 w-3.5" />
            {t.programmaticAccess.capture.createProfile}
          </Button>
        </div>
        <p className="text-[12px] text-muted-foreground">{t.programmaticAccess.capture.poolingHint}</p>
      </div>}
      </div>}

      {profiles.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-5 py-8 text-center text-[13px] text-muted-foreground">
          {t.programmaticAccess.capture.empty}
        </div>
      ) : profiles.map((profile) => (
        <details key={profile.id} className="rounded-xl border border-border bg-card overflow-hidden">
          <summary className="flex min-h-8 max-sm:min-h-11 cursor-pointer flex-wrap items-center gap-3 px-4 py-3 focus-visible:outline-2 focus-visible:outline-ring">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Database className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium truncate">{profile.name}</div>
              <div className="mt-1 text-xs text-muted-foreground">{profile.processingMode==="archive_only"?t.engineeringHistory.archive:t.engineeringHistory.extract}</div>
              {profile.processingMode==="archive_only"&&<p className="mt-1 break-words text-xs text-muted-foreground">{t.engineeringHistory.audience}: {Array.from(new Set(profile.rules.flatMap(rule=>[...rule.compartments.map(key=>teams.find(team=>`team:${team.id}`===key)?.name??key),...rule.projectIds.map(id=>projects.find(project=>project.id===id)?.name??id)]))).join(" / ")}</p>}

              <div className="text-[11px] text-muted-foreground">
                {format(t.programmaticAccess.capture.profileMeta, {
                  partition: partitionItems[profile.partitionBy],
                  count: profile.rules.length,
                })}
              </div>
            </div>
            <span className="text-xs text-muted-foreground">{profile.enabled ? t.programmaticAccess.navigation.enabled : t.programmaticAccess.navigation.disabled}</span>
            <span className="text-sm underline underline-offset-4">{t.programmaticAccess.navigation.manage}</span>
          </summary>
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
            <Select value={profile.processingMode??"extract"} items={{extract:t.engineeringHistory.extract,archive_only:t.engineeringHistory.archive}} disabled={saving} onValueChange={value=>value&&run(async()=>{await updateCaptureProfile(workspaceId,{...profile,processingMode:value as "extract"|"archive_only"})})}><SelectTrigger className="min-h-8 max-sm:min-h-11 w-full sm:w-48" aria-label={t.engineeringHistory.purpose}><SelectValue/></SelectTrigger><SelectContent><SelectItem value="extract">{t.engineeringHistory.extract}</SelectItem><SelectItem value="archive_only">{t.engineeringHistory.archive}</SelectItem></SelectContent></Select>
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => run(async () => {
                await updateCaptureProfile(workspaceId, { ...profile, enabled: !profile.enabled });
              })}
            >
              {profile.enabled ? t.programmaticAccess.capture.disable : t.programmaticAccess.capture.enable}
            </Button>
            <button
              type="button"
              title={t.programmaticAccess.capture.deleteProfile}
              className="inline-flex min-h-8 max-sm:min-h-11 min-w-8 max-sm:min-w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring"
              onClick={async () => {
                const ok = await confirmDialog({
                  title: t.programmaticAccess.capture.deleteProfileTitle,
                  description: format(t.programmaticAccess.capture.deleteProfileBody, { name: profile.name }),
                  confirmLabel: t.programmaticAccess.capture.deleteProfile,
                  variant: "destructive",
                });
                if (ok) await run(() => deleteCaptureProfile(workspaceId, profile.id));
              }}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>

          <div className="p-4 flex flex-col gap-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t.programmaticAccess.capture.orderedRules}
            </div>
            {profile.rules.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">{t.programmaticAccess.capture.noRules}</p>
            ) : (
              <ol className="flex flex-col divide-y divide-border">
                {profile.rules.map((rule, index) => (
                  <li key={rule.id} className="flex items-center gap-2 py-2 text-[12px]">
                    <span className="text-muted-foreground tabular-nums">{index + 1}.</span>
                    <span className="font-medium">{t.programmaticAccess.capture.filters[rule.filterType]}</span>
                    <span className="text-muted-foreground truncate flex-1">{JSON.stringify(rule.filterParams)}</span>
                    <span className="rounded-full bg-background px-2 py-0.5">{t.programmaticAccess.capture.routing[rule.routingMode]}</span>
                    <button
                      type="button"
                      title={t.programmaticAccess.capture.deleteRule}
                      className="inline-flex min-h-8 max-sm:min-h-11 min-w-8 max-sm:min-w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => run(() => deleteCaptureRule(workspaceId, profile.id, rule.id))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <NewRuleForm
              disabled={saving}
              onAdd={(rule) => run(async () => {
                await addCaptureRule(workspaceId, profile.id, {
                  ...rule,
                  ruleOrder: Math.max(-1, ...profile.rules.map((entry) => entry.ruleOrder)) + 1,
                  episodeSensitivity: null,
                  compartments: [],
                  projectIds: [],
                  scopeBindingMode: "inherit",
                });
              })}
            />
          </div>
        </details>
      ))}

      {assistants.length > 0 && (
        <details className="group rounded-xl border border-border bg-card p-4">
          <summary className="flex min-h-8 max-sm:min-h-11 cursor-pointer items-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">{t.programmaticAccess.capture.assistantDefaults}<ChevronDown aria-hidden className="ml-auto size-4 transition-transform group-open:rotate-180" /></summary>
          <div className="mb-3">
            <p className="text-[12px] text-muted-foreground">{t.programmaticAccess.capture.assistantDefaultsHint}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {assistants.map((assistant) => {
              const selected = profiles.find((profile) => profile.assistantIds.includes(assistant.id))?.id ?? CAPTURE_NONE;
              return (
                <div key={assistant.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px]">{assistant.name}</span>
                  <Select
                    value={selected}
                    items={profileItems}
                    onValueChange={(value) => value && run(() =>
                      setAssistantCaptureProfile(workspaceId, assistant.id, value === CAPTURE_NONE ? null : value))}
                  >
                    <SelectTrigger size="sm" className="min-h-8 max-sm:min-h-11 w-44" aria-label={t.programmaticAccess.capture.assistantDefaultProfile}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={CAPTURE_NONE}>{t.programmaticAccess.capture.noDefault}</SelectItem>
                      {profiles.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </section>
  );
}

function NewRuleForm({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (rule: {
    filterType: CaptureFilterType;
    filterParams: Record<string, unknown>;
    routingMode: CaptureRoutingMode;
    routingSchedule: string | null;
    routingTimezone: string;
  }) => void;
}) {
  const t = useT();
  const [filterType, setFilterType] = useState<CaptureFilterType>("always");
  const [filterValue, setFilterValue] = useState("");
  const [routingMode, setRoutingMode] = useState<CaptureRoutingMode>("scheduled");
  const [schedule, setSchedule] = useState("0 * * * *");

  const filterItems = t.programmaticAccess.capture.filters;
  const routingItems = t.programmaticAccess.capture.routing;
  const needsValue = filterType !== "always";

  function filterParams(): Record<string, unknown> | null {
    const values = filterValue.split(",").map((value) => value.trim()).filter(Boolean);
    if (filterType === "always") return {};
    if (filterType === "keyword_match") return values.length > 0 ? { keywords: values } : null;
    if (filterType === "actor_match" || filterType === "role_match") {
      return values.length > 0 ? { values } : null;
    }
    const separator = filterValue.indexOf("=");
    if (separator < 1) return null;
    return {
      key: filterValue.slice(0, separator).trim(),
      value: filterValue.slice(separator + 1).trim(),
    };
  }

  const params = filterParams();
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Select value={filterType} items={filterItems} onValueChange={(value) => value && setFilterType(value as CaptureFilterType)}>
        <SelectTrigger className="min-h-8 max-sm:min-h-11" size="sm" aria-label={t.programmaticAccess.capture.filterLabel}><SelectValue /></SelectTrigger>
        <SelectContent>
          {Object.entries(filterItems).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
        </SelectContent>
      </Select>
      <input
        value={filterValue}
        onChange={(event) => setFilterValue(event.target.value)}
        disabled={!needsValue}
        placeholder={filterType === "metadata_match"
          ? t.programmaticAccess.capture.metadataPlaceholder
          : t.programmaticAccess.capture.valuesPlaceholder}
        className="bg-muted/50 border border-border rounded-lg px-3 py-1.5 text-[16px] md:text-[12px] disabled:opacity-50"
      />
      <Select value={routingMode} items={routingItems} onValueChange={(value) => value && setRoutingMode(value as CaptureRoutingMode)}>
        <SelectTrigger className="min-h-8 max-sm:min-h-11" size="sm" aria-label={t.programmaticAccess.capture.routingLabel}><SelectValue /></SelectTrigger>
        <SelectContent>
          {Object.entries(routingItems).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
        </SelectContent>
      </Select>
      <input
        value={schedule}
        onChange={(event) => setSchedule(event.target.value)}
        disabled={routingMode !== "scheduled"}
        placeholder="0 * * * *"
        aria-label={t.programmaticAccess.capture.scheduleLabel}
        className="bg-muted/50 border border-border rounded-lg px-3 py-1.5 font-mono text-[16px] md:text-[12px] disabled:opacity-50"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || !params || (routingMode === "scheduled" && !schedule.trim())}
        onClick={() => onAdd({
          filterType,
          filterParams: params ?? {},
          routingMode,
          routingSchedule: routingMode === "scheduled" ? schedule.trim() : null,
          routingTimezone: "UTC",
        })}
      >
        {t.programmaticAccess.capture.addRule}
      </Button>
    </div>
  );
}
