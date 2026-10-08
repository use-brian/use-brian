"use client";

/**
 * Organization -> Departments: who reads a department and how deep (permission
 * model v2), and home departments. Calls the same commands as Brian's
 * `manageDepartments` tool (D25). Spec: docs/architecture/features/workspace-access.md
 * -> "Department management and home departments (v2, migration 651)".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarClock, Check, Crown, MoreHorizontal, ShieldAlert, Trash2, UserPlus, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { openWorkspaceSettings } from "@/lib/workspace-settings-events";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { listWorkspaceMembers } from "@/lib/api/mentions";
import { useWorkspaceDirectory } from "@/lib/use-workspace-directory";
import { listAssistants } from "@/lib/api/studio";
import { fetchWorkspaceAccess, ORGANIZATION_CHANGED_EVENT } from "@/lib/api/workspace-access";
import { invalidateSurfaceCache, markSurfaceCacheStale, seedSurfaceCache, useCachedResource, warmSurfaceCache } from "@/lib/surface-cache";
import { assistantsCacheKey, departmentDirectoryCacheKey, departmentEdgesCacheKey, departmentReadersCacheKey, workspaceAccessCacheKey } from "@/lib/surface-prefetch";
import { ClearanceBar, ClearancePill, InfoNote, OrgAvatar, type Clearance } from "./org-visuals";
import { isCatchUpRefresh, WORKSPACE_IDENTITY_REFRESH_EVENT } from "@/lib/workspace-identity-events";
import {
  DEPARTMENTS_CHANGED_EVENT, DepartmentRequestError, addDepartmentOwner, breakGlassDepartment, fetchDepartmentEdges,
  fetchDepartments, removeDepartmentEdge, removeDepartmentOwner, setDepartmentEdge, setHomeDepartment,
  type DepartmentClearance, type DepartmentDirectoryEntry, type DepartmentEdge, type DepartmentHome, type DepartmentPrincipal,
} from "@/lib/api/departments";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";

const CLEARANCES: DepartmentClearance[] = ["public", "internal", "confidential"];
type Names = Map<string, string>;
const key = (p: DepartmentPrincipal) => `${p.kind}:${p.id}`;

/** People and assistant names, for rendering ids. Assistants come from the
 * shared Studio roster slot; members from the member directory, SUBSCRIBED
 * rather than read once: the event spine's catch-up invalidates the directory
 * while the first read is in flight, and a mount-only read kept that empty
 * answer, so names fell back to "Person" and Add offered nobody. */
function useNames(workspaceId: string) {
  const assistants = useLeasedResource(assistantsCacheKey(workspaceId), () => listAssistants(workspaceId));
  const people = useWorkspaceDirectory(workspaceId);
  return useMemo(() => {
    const roster = assistants.data ?? [];
    const names: Names = new Map();
    for (const person of people) names.set(`user:${person.id}`, person.name);
    for (const assistant of roster) names.set(`assistant:${assistant.id}`, assistant.name);
    return { names, userIds: people.map(person => person.id), assistantIds: roster.map(assistant => assistant.id) };
  }, [people, assistants.data]);
}

type Directory = { departments: DepartmentDirectoryEntry[]; homes: DepartmentHome[] };
const loadDirectory = (workspaceId: string): Promise<Directory> => fetchDepartments(workspaceId)
  .then(r => ({ departments: Array.isArray(r?.departments) ? r.departments : [], homes: Array.isArray(r?.homes) ? r.homes : [] }));
const loadEdges = (workspaceId: string, departmentId: string): Promise<DepartmentEdge[]> =>
  fetchDepartmentEdges(workspaceId, departmentId).then(r => Array.isArray(r?.edges) ? r.edges : []);

/**
 * Start every request the Departments section needs at once, before the
 * registry gate has painted. Without this the directory, roster and access
 * overview only begin after the registry round trip lands (a serial chain).
 */
export function warmDepartmentsSection(workspaceId: string, userId: string) {
  warmSurfaceCache(departmentDirectoryCacheKey(workspaceId, userId), () => loadDirectory(workspaceId));
  warmSurfaceCache(assistantsCacheKey(workspaceId), () => listAssistants(workspaceId));
  warmSurfaceCache(workspaceAccessCacheKey(workspaceId, userId), () => fetchWorkspaceAccess(workspaceId));
  void listWorkspaceMembers(workspaceId).catch(() => {});
}

/** Refresh on a department change; drop the viewer's department family on an
 * authority signal so a changed role never repaints the previous answer. The
 * stream's reconnect catch-up (every ~5 minutes) is not one: it revalidates
 * behind the paint, or the section blinks to a skeleton on that cadence. */
function useDepartmentSignals(workspaceId: string, userId: string, refresh: () => Promise<unknown>) {
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    const onChange = (event: Event) => { if ((event as CustomEvent<{ workspaceId: string }>).detail?.workspaceId === workspaceId) void refreshRef.current(); };
    const purge = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;
      if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
      const family = `departments:${workspaceId}:${userId}:`;
      if (isCatchUpRefresh(event)) markSurfaceCacheStale(family); else invalidateSurfaceCache(family);
    };
    window.addEventListener(DEPARTMENTS_CHANGED_EVENT, onChange);
    window.addEventListener(ORGANIZATION_CHANGED_EVENT, purge);
    window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT, purge);
    return () => {
      window.removeEventListener(DEPARTMENTS_CHANGED_EVENT, onChange);
      window.removeEventListener(ORGANIZATION_CHANGED_EVENT, purge);
      window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT, purge);
    };
  }, [workspaceId, userId]);
}

/** Departments directory plus homes, refreshed on every department change. */
function useDirectory(workspaceId: string) {
  const { me } = useWorkspaceContext();
  const resource = useCachedResource(departmentDirectoryCacheKey(workspaceId, me.id), () => loadDirectory(workspaceId));
  useDepartmentSignals(workspaceId, me.id, resource.refresh);
  const data: Directory | null = resource.data ?? (resource.error !== undefined ? { departments: [], homes: [] } : null);
  const refresh = resource.refresh;
  const reload = useCallback(() => { void refresh(); }, [refresh]);
  return { data, reload };
}

/**
 * Reader edges for every listed department at once, for the department cards.
 * Lives in the department cache family, so the same signals refresh and purge
 * it, and seeds each department's own slot so opening a card paints at once.
 * A department the viewer cannot read maps to no entry.
 */
export function useDepartmentReaders(departmentIds: string[]) {
  const { workspaceId, me } = useWorkspaceContext();
  const signature = [...departmentIds].sort().join(",");
  const ids = useMemo(() => (signature ? signature.split(",") : []), [signature]);
  const key = ids.length ? departmentReadersCacheKey(workspaceId, me.id, ids) : null;
  const resource = useCachedResource(key, async () => {
    const rows = await Promise.all(ids.map(id => loadEdges(workspaceId, id).then(edges => [id, edges] as const, () => null)));
    const edges = new Map<string, DepartmentEdge[]>();
    for (const row of rows) {
      if (!row) continue;
      edges.set(row[0], row[1]);
      seedSurfaceCache(departmentEdgesCacheKey(workspaceId, me.id, row[0]), row[1]);
    }
    return edges;
  });
  useDepartmentSignals(workspaceId, me.id, resource.refresh);
  const { data } = useDirectory(workspaceId);
  return { edges: resource.data ?? null, directory: data?.departments ?? null };
}

export const clearanceCounts = (edges: DepartmentEdge[]): Record<Clearance, number> =>
  edges.reduce((counts, edge) => ({ ...counts, [edge.clearance]: counts[edge.clearance] + 1 }), { public: 0, internal: 0, confidential: 0 } as Record<Clearance, number>);

function useErrorCopy() {
  const t = useT().departmentAccess;
  return (error: unknown) => {
    const code = error instanceof DepartmentRequestError ? error.code : "";
    return code === "department_revision_stale" ? t.errorStale
      : code === "department_clearance_above_own" ? t.errorAboveOwn
      : code === "department_last_owner" ? t.errorLastOwner
      : code === "department_owner_edge_required" ? t.errorOwnerEdge
      : code === "department_access_via_grant" ? t.errorViaGrant
      : code === "department_primary_assistant" ? t.errorPrimary
      : code === "department_expiry_invalid" ? t.errorExpiry
      : t.errorGeneric;
  };
}

/** A date input's YYYY-MM-DD, as the end of that day in the viewer's time zone. */
const endOfDay = (value: string): string | null => value ? new Date(`${value}T23:59:59`).toISOString() : null;
const dateValue = (iso: string | null): string => {
  if (!iso) return "";
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const today = () => dateValue(new Date().toISOString());
const dateInputClass = "h-8 min-w-0 rounded-lg border border-border bg-background px-3 text-[16px] text-foreground outline-none focus-visible:border-ring max-sm:h-11 md:text-sm";

export function DepartmentAccessPanel({ departmentId }: { departmentId: string }) {
  const { workspaceId, me, role } = useWorkspaceContext();
  const dictionary = useT(), t = dictionary.departmentAccess;
  const errorCopy = useErrorCopy();
  const { data: directory, reload: reloadDirectory } = useDirectory(workspaceId);
  const { names, userIds, assistantIds } = useNames(workspaceId);
  const edgeResource = useCachedResource(departmentEdgesCacheKey(workspaceId, me.id, departmentId), () => loadEdges(workspaceId, departmentId));
  const edges: DepartmentEdge[] | null = edgeResource.data ?? (edgeResource.error !== undefined ? [] : null);
  useDepartmentSignals(workspaceId, me.id, edgeResource.refresh);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [addClearance, setAddClearance] = useState<DepartmentClearance>("internal");
  const [addUntil, setAddUntil] = useState("");
  const [editingExpiry, setEditingExpiry] = useState<{ key: string; value: string } | null>(null);
  const entry = directory?.departments.find(d => d.departmentId === departmentId) ?? null;

  const refreshEdges = edgeResource.refresh;
  const reload = useCallback(() => { void refreshEdges(); }, [refreshEdges]);
  useEffect(() => { setEditingExpiry(null); setAdding(""); setAddUntil(""); setError(null); }, [departmentId]);

  const run = async (change: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await change(); return true; } catch (cause) { setError(errorCopy(cause)); reload(); reloadDirectory(); return false; } finally { setBusy(false); }
  };
  const label = (p: DepartmentPrincipal) => names.get(key(p)) ?? (p.kind === "user" ? t.person : t.assistant);
  const clearanceLabel = (c: DepartmentClearance) => c === "public" ? t.clearancePublic : c === "internal" ? t.clearanceInternal : t.clearanceConfidential;
  const owners = useMemo(() => new Set(entry?.ownerIds ?? []), [entry]);
  const candidates = useMemo(() => {
    const present = new Set((edges ?? []).map(e => key(e.principal)));
    return [...userIds.map(id => ({ kind: "user" as const, id })), ...assistantIds.map(id => ({ kind: "assistant" as const, id }))]
      .filter(p => !present.has(key(p)));
  }, [edges, userIds, assistantIds]);

  if (!directory || edges === null) return <div aria-hidden className="h-24 animate-pulse rounded-lg bg-muted/40" />;
  const canManage = entry?.isOwner === true;
  const wsOwnerOutside = entry !== null && entry.myClearance === null;
  const revision = entry?.revision;

  const row = (edge: DepartmentEdge) => {
    const rowKey = key(edge.principal);
    const isOwner = edge.principal.kind === "user" && owners.has(edge.principal.id);
    const isPrimary = edge.origin === "primary";
    const viaGrant = edge.origin === "grant";
    const name = label(edge.principal);
    // Owners read at Confidential by construction; the primary assistant reads
    // every department; a grant is ended where it was approved (D26).
    const fixed = isOwner || isPrimary || viaGrant;
    const lastOwner = isOwner && owners.size <= 1;
    const editing = editingExpiry?.key === rowKey ? editingExpiry : null;
    return (
      <li key={rowKey} className="space-y-3 px-1 py-1.5">
        <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2 max-sm:min-h-11">
          <OrgAvatar name={name} kind={edge.principal.kind === "user" ? "member" : "assistant"} seed={edge.principal.id} size={26} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="truncate font-medium">{name}</span>
              {edge.principal.kind === "user" && edge.principal.id === me.id ? <span className="text-xs text-muted-foreground">{t.you}</span> : null}
              {isOwner ? <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"><Crown className="size-3" aria-hidden />{t.owner}</span> : null}
              {isPrimary ? <span title={t.everyDepartmentHint} className="rounded-full bg-muted px-2 py-0.5 text-xs">{t.everyDepartment}</span> : null}
              {viaGrant ? <span title={t.viaGrantHint} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{t.viaGrant}</span> : null}
              {edge.origin === "migrated" ? <span title={t.carriedOverHint} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{t.carriedOver}</span> : null}
            </div>
            {edge.expiresAt ? <p className="text-xs text-muted-foreground">{format(t.expires, { date: new Date(edge.expiresAt).toLocaleDateString() })}</p> : null}
          </div>
          {canManage && !fixed ? (
            <Select value={edge.clearance} onValueChange={(value) => { if (value && value !== edge.clearance) void run(() => setDepartmentEdge(workspaceId, departmentId, { principal: edge.principal, clearance: value as DepartmentClearance, expiresAt: edge.expiresAt, expectedRevision: revision })); }}>
              <SelectTrigger aria-label={format(t.clearanceLabel, { name })} className="w-40 max-sm:min-h-11" disabled={busy}>
                <SelectValue>{clearanceLabel(edge.clearance)}</SelectValue>
              </SelectTrigger>
              <SelectContent>{CLEARANCES.map(c => <SelectItem key={c} value={c}>{clearanceLabel(c)}</SelectItem>)}</SelectContent>
            </Select>
          ) : <ClearancePill clearance={edge.clearance} label={clearanceLabel(edge.clearance)} />}
          {canManage && !isPrimary && !viaGrant ? (
            <DropdownMenu>
              <DropdownMenuTrigger aria-label={format(t.actionsLabel, { name })} disabled={busy}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 max-sm:size-11">
                <MoreHorizontal className="size-4" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!isOwner ? <DropdownMenuItem className="max-sm:min-h-11" onClick={() => setEditingExpiry({ key: rowKey, value: dateValue(edge.expiresAt) })}>
                  <CalendarClock className="size-4" aria-hidden />{edge.expiresAt ? t.changeEndDate : t.setEndDate}
                </DropdownMenuItem> : null}
                {edge.principal.kind === "user" ? <DropdownMenuItem className="max-sm:min-h-11" disabled={lastOwner} onClick={() => void run(() => isOwner
                  ? removeDepartmentOwner(workspaceId, departmentId, edge.principal.id, revision)
                  : addDepartmentOwner(workspaceId, departmentId, edge.principal.id, revision))}>
                  <Crown className="size-4" aria-hidden />{isOwner ? t.removeOwner : t.makeOwner}
                </DropdownMenuItem> : null}
                {!isOwner ? <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" className="max-sm:min-h-11" onClick={() => void (async () => {
                    const ok = await confirmDialog({ title: t.removeTitle, description: format(t.removeDescription, { name }), confirmLabel: t.remove, variant: "destructive" });
                    if (ok) await run(() => removeDepartmentEdge(workspaceId, departmentId, { principal: edge.principal, expectedRevision: revision }));
                  })()}><Trash2 className="size-4" aria-hidden />{t.remove}</DropdownMenuItem>
                </> : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {editing ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-border/70 pt-3">
            <label className="grid gap-1 text-xs text-muted-foreground">
              {format(t.endDateLabel, { name })}
              <input type="date" min={today()} value={editing.value} disabled={busy} className={dateInputClass}
                onChange={(event) => setEditingExpiry({ key: rowKey, value: event.target.value })} />
            </label>
            <Button disabled={busy || !editing.value} onClick={() => void (async () => {
              if (await run(() => setDepartmentEdge(workspaceId, departmentId, { principal: edge.principal, clearance: edge.clearance, expiresAt: endOfDay(editing.value), expectedRevision: revision }))) setEditingExpiry(null);
            })()}><Check className="size-4" aria-hidden />{t.saveEndDate}</Button>
            {edge.expiresAt ? <Button variant="outline" disabled={busy} onClick={() => void (async () => {
              if (await run(() => setDepartmentEdge(workspaceId, departmentId, { principal: edge.principal, clearance: edge.clearance, expiresAt: null, expectedRevision: revision }))) setEditingExpiry(null);
            })()}>{t.clearEndDate}</Button> : null}
            <Button variant="ghost" disabled={busy} onClick={() => setEditingExpiry(null)}>{t.cancel}</Button>
          </div>
        ) : null}
      </li>
    );
  };
  const people = edges.filter(e => e.principal.kind === "user");
  const assistants = edges.filter(e => e.principal.kind === "assistant");
  const group = (title: string, rows: DepartmentEdge[], empty: string) => (
    <div>
      <h4 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}<span className="rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums normal-case">{rows.length}</span></h4>
      {rows.length ? <ul className="divide-y divide-border border-y border-border">{rows.map(row)}</ul> : <p className="py-3 text-sm text-muted-foreground">{empty}</p>}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(14rem,20rem)] md:items-start">
        <div className="min-w-0 space-y-1">
          <h3 className="font-semibold">{t.title}</h3>
          <InfoNote>{canManage ? t.summary : wsOwnerOutside ? t.notMember : t.readOnly}</InfoNote>
        </div>
        {!wsOwnerOutside && edges.length ? <ClearanceBar counts={clearanceCounts(edges)} labels={{ public: t.clearancePublic, internal: t.clearanceInternal, confidential: t.clearanceConfidential }} /> : null}
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {canManage ? (
        <section className="space-y-3 rounded-lg bg-muted/30 p-3">
          <h4 className="text-sm font-medium">{t.addTitle}</h4>
          <p className="text-sm text-muted-foreground">{t.addHelp}</p>
          {candidates.length === 0 ? <p role="status" className="text-sm text-muted-foreground">{t.addEmpty}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_10rem_auto_auto] lg:items-end">
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t.addWho}
              <SearchableSelect aria-label={t.addWho} value={adding} onValueChange={setAdding} disabled={busy || candidates.length === 0} className="h-8 max-sm:min-h-11"
                placeholder={t.addPlaceholder} searchPlaceholder={t.addSearch} emptyMessage={t.addNoMatches}
                items={candidates.map(p => ({ value: key(p), label: label(p), hint: p.kind === "user" ? t.person : t.assistant }))} />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t.addClearance}
              <Select value={addClearance} onValueChange={(value) => { if (value) setAddClearance(value as DepartmentClearance); }}>
                <SelectTrigger aria-label={t.addClearance} className="w-full max-sm:min-h-11" disabled={busy}><SelectValue>{clearanceLabel(addClearance)}</SelectValue></SelectTrigger>
                <SelectContent>{CLEARANCES.map(c => <SelectItem key={c} value={c}>{clearanceLabel(c)}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t.addEndDate}
              <input type="date" min={today()} value={addUntil} disabled={busy} className={dateInputClass} onChange={(event) => setAddUntil(event.target.value)} />
            </label>
            <Button disabled={busy || !adding} onClick={() => {
              const [kind, id] = adding.split(":") as [DepartmentPrincipal["kind"], string];
              void (async () => {
                if (await run(() => setDepartmentEdge(workspaceId, departmentId, { principal: { kind, id }, clearance: addClearance, expiresAt: endOfDay(addUntil), expectedRevision: revision }))) {
                  setAdding(""); setAddUntil("");
                }
              })();
            }}><UserPlus className="size-4" aria-hidden />{t.add}</Button>
          </div>
          {role === "owner" || role === "admin" ? (
            <Button variant="link" className="h-auto whitespace-normal px-0 text-left max-sm:min-h-11" onClick={() => openWorkspaceSettings("ws-members")}>{t.workspacePeople}</Button>
          ) : <p className="text-sm text-muted-foreground">{t.askWorkspaceAdmin}</p>}
        </section>
      ) : null}
      {wsOwnerOutside ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void (async () => {
          const ok = await confirmDialog({ title: t.breakGlassTitle, description: t.breakGlassDescription, confirmLabel: t.breakGlass, variant: "destructive" });
          if (!ok) return;
          const reason = (await promptDialog({ title: t.breakGlassReason }))?.trim();
          if (reason) await run(() => breakGlassDepartment(workspaceId, departmentId, reason));
        })()}><ShieldAlert className="size-4" aria-hidden />{t.breakGlass}</Button>
      ) : edges.length === 0 ? <p className="text-sm text-muted-foreground">{t.empty}</p> : (
        <div className="grid gap-5 md:grid-cols-2">
          {group(t.people, people, t.noPeople)}
          {group(t.assistants, assistants, t.noAssistants)}
        </div>
      )}

    </div>
  );
}

/** Home-department pickers over the shared directory; the server enforces who may set which home. */
function useHomePicker() {
  const { workspaceId } = useWorkspaceContext();
  const t = useT().homeDepartment;
  const errorCopy = useErrorCopy();
  const { data, reload } = useDirectory(workspaceId);
  const [error, setError] = useState<string | null>(null);
  const none = "__general__";
  const save = async (principal: DepartmentPrincipal, value: string) => {
    setError(null);
    try { await setHomeDepartment(workspaceId, principal, value === none ? null : value); }
    catch (cause) {
      const code = cause instanceof DepartmentRequestError ? cause.code : "";
      setError(code === "department_home_requires_edge" ? t.requiresMember : code === "department_home_not_allowed" ? t.notAllowed : errorCopy(cause));
      reload();
    }
  };
  const picker = (home: DepartmentHome, label: string, avatar?: ReactNode) => {
    if (!data) return null;
    const memberOf = data.departments.filter(d => d.myClearance !== null && d.status === "active");
    const current = home.departmentId ?? none;
    const currentName = data.departments.find(d => d.departmentId === home.departmentId)?.name ?? t.none;
    return (
      <div key={key(home.principal)} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-2 text-sm">{avatar}<span className="truncate">{label}</span></span>
        <Select value={current} onValueChange={(value) => { if (value && value !== current) void save(home.principal, value); }}>
          <SelectTrigger aria-label={label} className="w-48 max-sm:min-h-11"><SelectValue>{currentName}</SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value={none}>{t.none}</SelectItem>
            {memberOf.map(d => <SelectItem key={d.departmentId} value={d.departmentId}>{d.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    );
  };
  return { data, error, picker };
}

/** Your home department, and those of assistants you may configure. */
export function HomeDepartmentControls() {
  const { workspaceId, me } = useWorkspaceContext();
  const dictionary = useT(), t = dictionary.homeDepartment;
  const { names } = useNames(workspaceId);
  const { data, error, picker } = useHomePicker();
  if (!data) return <div aria-hidden className="h-16 animate-pulse rounded-lg bg-muted/40" />;
  const mine = data.homes.find(h => h.principal.kind === "user" && h.principal.id === me.id);
  const assistants = data.homes.filter(h => h.principal.kind === "assistant");
  return (
    <section className="space-y-3 rounded-xl border border-border bg-background p-4 md:p-5">
      <div className="space-y-1">
        <h3 className="font-semibold">{t.title}</h3>
        <InfoNote>{t.summary}</InfoNote>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {mine ? picker(mine, t.mine, names.get(`user:${me.id}`)
        ? <OrgAvatar name={names.get(`user:${me.id}`)!} seed={me.id} size={24} />
        : <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><UserRound className="size-3.5" /></span>) : null}
      {assistants.length > 0 ? (
        <div className="space-y-2 border-t border-border/70 pt-3">
          <p className="text-xs font-medium uppercase text-muted-foreground">{t.assistants}</p>
          <div className="grid gap-x-8 gap-y-2 lg:grid-cols-2">
            {assistants.map(home => {
              const name = names.get(key(home.principal)) ?? dictionary.departmentAccess.assistant;
              return picker(home, name, <OrgAvatar name={name} kind="assistant" seed={home.principal.id} size={24} />);
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** One assistant's home department, for its settings page. Hidden when the viewer may not set it. */
export function AssistantHomeDepartment({ assistantId }: { assistantId: string }) {
  const t = useT().homeDepartment;
  const { data, error, picker } = useHomePicker();
  const home = data?.homes.find(h => h.principal.kind === "assistant" && h.principal.id === assistantId);
  if (!home) return null;
  return (
    <div className="space-y-2">
      {picker(home, t.assistantHome)}
      <p className="text-xs text-muted-foreground">{t.summary}</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
