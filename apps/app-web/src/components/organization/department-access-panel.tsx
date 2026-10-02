"use client";

/**
 * Organization -> Departments: who reads a department and how deep (permission
 * model v2), and home departments. Calls the same commands as Brian's
 * `manageDepartments` tool (D25). Spec: docs/architecture/features/workspace-access.md
 * -> "Department management and home departments (v2, migration 651)".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Check, Crown, MoreHorizontal, ShieldAlert, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { listWorkspaceMembers } from "@/lib/api/mentions";
import { listAssistants } from "@/lib/api/studio";
import {
  DEPARTMENTS_CHANGED_EVENT, DepartmentRequestError, addDepartmentOwner, breakGlassDepartment, fetchDepartmentEdges,
  fetchDepartments, removeDepartmentEdge, removeDepartmentOwner, setDepartmentEdge, setHomeDepartment,
  type DepartmentClearance, type DepartmentDirectoryEntry, type DepartmentEdge, type DepartmentHome, type DepartmentPrincipal,
} from "@/lib/api/departments";

const CLEARANCES: DepartmentClearance[] = ["public", "internal", "confidential"];
type Names = Map<string, string>;
const key = (p: DepartmentPrincipal) => `${p.kind}:${p.id}`;

/** People and assistant names, for rendering ids. */
function useNames(workspaceId: string) {
  const [names, setNames] = useState<Names>(new Map());
  const [assistantIds, setAssistantIds] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void Promise.all([listWorkspaceMembers(workspaceId), listAssistants(workspaceId)]).then(([people, assistants]) => {
      if (!live) return;
      const next: Names = new Map();
      for (const person of people) next.set(`user:${person.id}`, person.name);
      for (const assistant of assistants) next.set(`assistant:${assistant.id}`, assistant.name);
      setNames(next);
      setUserIds(people.map(person => person.id));
      setAssistantIds(assistants.map(assistant => assistant.id));
    }).catch(() => {});
    return () => { live = false; };
  }, [workspaceId]);
  return { names, userIds, assistantIds };
}

/** Departments directory plus homes, refreshed on every department change. */
function useDirectory(workspaceId: string) {
  const [data, setData] = useState<{ departments: DepartmentDirectoryEntry[]; homes: DepartmentHome[] } | null>(null);
  const reload = useCallback(() => {
    fetchDepartments(workspaceId)
      .then(r => setData({ departments: Array.isArray(r?.departments) ? r.departments : [], homes: Array.isArray(r?.homes) ? r.homes : [] }))
      .catch(() => setData({ departments: [], homes: [] }));
  }, [workspaceId]);
  useEffect(() => {
    reload();
    const onChange = (event: Event) => { if ((event as CustomEvent<{ workspaceId: string }>).detail?.workspaceId === workspaceId) reload(); };
    window.addEventListener(DEPARTMENTS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(DEPARTMENTS_CHANGED_EVENT, onChange);
  }, [workspaceId, reload]);
  return { data, reload };
}

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
const dateInputClass = "min-h-11 min-w-0 rounded-lg border border-border bg-background px-3 text-[16px] text-foreground outline-none focus-visible:border-ring md:text-sm";

export function DepartmentAccessPanel({ departmentId }: { departmentId: string }) {
  const { workspaceId, me } = useWorkspaceContext();
  const dictionary = useT(), t = dictionary.departmentAccess;
  const errorCopy = useErrorCopy();
  const { data: directory, reload: reloadDirectory } = useDirectory(workspaceId);
  const { names, userIds, assistantIds } = useNames(workspaceId);
  const [edges, setEdges] = useState<DepartmentEdge[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [addClearance, setAddClearance] = useState<DepartmentClearance>("internal");
  const [addUntil, setAddUntil] = useState("");
  const [editingExpiry, setEditingExpiry] = useState<{ key: string; value: string } | null>(null);
  const entry = directory?.departments.find(d => d.departmentId === departmentId) ?? null;

  const reload = useCallback(() => {
    fetchDepartmentEdges(workspaceId, departmentId).then(r => setEdges(Array.isArray(r?.edges) ? r.edges : [])).catch(() => setEdges([]));
  }, [workspaceId, departmentId]);
  useEffect(() => {
    reload();
    const onChange = (event: Event) => { if ((event as CustomEvent<{ workspaceId: string }>).detail?.workspaceId === workspaceId) reload(); };
    window.addEventListener(DEPARTMENTS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(DEPARTMENTS_CHANGED_EVENT, onChange);
  }, [workspaceId, reload]);
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
      <li key={rowKey} className="space-y-3 rounded-lg border border-border/70 px-3 py-2">
        <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
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
              <SelectTrigger aria-label={format(t.clearanceLabel, { name })} className="min-h-11 w-40" disabled={busy}>
                <SelectValue>{clearanceLabel(edge.clearance)}</SelectValue>
              </SelectTrigger>
              <SelectContent>{CLEARANCES.map(c => <SelectItem key={c} value={c}>{clearanceLabel(c)}</SelectItem>)}</SelectContent>
            </Select>
          ) : <span className="text-sm text-muted-foreground">{clearanceLabel(edge.clearance)}</span>}
          {canManage && !isPrimary && !viaGrant ? (
            <DropdownMenu>
              <DropdownMenuTrigger aria-label={format(t.actionsLabel, { name })} disabled={busy}
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
                <MoreHorizontal className="size-4" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!isOwner ? <DropdownMenuItem className="min-h-11" onClick={() => setEditingExpiry({ key: rowKey, value: dateValue(edge.expiresAt) })}>
                  <CalendarClock className="size-4" aria-hidden />{edge.expiresAt ? t.changeEndDate : t.setEndDate}
                </DropdownMenuItem> : null}
                {edge.principal.kind === "user" ? <DropdownMenuItem className="min-h-11" disabled={lastOwner} onClick={() => void run(() => isOwner
                  ? removeDepartmentOwner(workspaceId, departmentId, edge.principal.id, revision)
                  : addDepartmentOwner(workspaceId, departmentId, edge.principal.id, revision))}>
                  <Crown className="size-4" aria-hidden />{isOwner ? t.removeOwner : t.makeOwner}
                </DropdownMenuItem> : null}
                {!isOwner ? <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" className="min-h-11" onClick={() => void (async () => {
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
            <Button size="sm" className="min-h-11" disabled={busy || !editing.value} onClick={() => void (async () => {
              if (await run(() => setDepartmentEdge(workspaceId, departmentId, { principal: edge.principal, clearance: edge.clearance, expiresAt: endOfDay(editing.value), expectedRevision: revision }))) setEditingExpiry(null);
            })()}><Check className="size-4" aria-hidden />{t.saveEndDate}</Button>
            {edge.expiresAt ? <Button variant="outline" size="sm" className="min-h-11" disabled={busy} onClick={() => void (async () => {
              if (await run(() => setDepartmentEdge(workspaceId, departmentId, { principal: edge.principal, clearance: edge.clearance, expiresAt: null, expectedRevision: revision }))) setEditingExpiry(null);
            })()}>{t.clearEndDate}</Button> : null}
            <Button variant="ghost" size="sm" className="min-h-11" disabled={busy} onClick={() => setEditingExpiry(null)}>{t.cancel}</Button>
          </div>
        ) : null}
      </li>
    );
  };
  const people = edges.filter(e => e.principal.kind === "user");
  const assistants = edges.filter(e => e.principal.kind === "assistant");
  const group = (title: string, rows: DepartmentEdge[], empty: string) => (
    <div>
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h4>
      {rows.length ? <ul className="space-y-2">{rows.map(row)}</ul> : <p className="text-sm text-muted-foreground">{empty}</p>}
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold">{t.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{canManage ? t.summary : wsOwnerOutside ? t.notMember : t.readOnly}</p>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {wsOwnerOutside ? (
        <Button variant="outline" size="sm" className="min-h-11" disabled={busy} onClick={() => void (async () => {
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
      {canManage && candidates.length > 0 ? (
        <section className="space-y-3 rounded-lg bg-muted/30 p-3">
          <h4 className="text-sm font-medium">{t.addTitle}</h4>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_10rem_auto_auto] lg:items-end">
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t.addWho}
              <SearchableSelect aria-label={t.addWho} value={adding} onValueChange={setAdding} disabled={busy} className="min-h-11"
                placeholder={t.addPlaceholder} searchPlaceholder={t.addSearch} emptyMessage={t.addNoMatches}
                items={candidates.map(p => ({ value: key(p), label: label(p), hint: p.kind === "user" ? t.person : t.assistant }))} />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t.addClearance}
              <Select value={addClearance} onValueChange={(value) => { if (value) setAddClearance(value as DepartmentClearance); }}>
                <SelectTrigger aria-label={t.addClearance} className="min-h-11 w-full" disabled={busy}><SelectValue>{clearanceLabel(addClearance)}</SelectValue></SelectTrigger>
                <SelectContent>{CLEARANCES.map(c => <SelectItem key={c} value={c}>{clearanceLabel(c)}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t.addEndDate}
              <input type="date" min={today()} value={addUntil} disabled={busy} className={dateInputClass} onChange={(event) => setAddUntil(event.target.value)} />
            </label>
            <Button size="sm" className="min-h-11" disabled={busy || !adding} onClick={() => {
              const [kind, id] = adding.split(":") as [DepartmentPrincipal["kind"], string];
              void (async () => {
                if (await run(() => setDepartmentEdge(workspaceId, departmentId, { principal: { kind, id }, clearance: addClearance, expiresAt: endOfDay(addUntil), expectedRevision: revision }))) {
                  setAdding(""); setAddUntil("");
                }
              })();
            }}><UserPlus className="size-4" aria-hidden />{t.add}</Button>
          </div>
        </section>
      ) : null}
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
  const picker = (home: DepartmentHome, label: string) => {
    if (!data) return null;
    const memberOf = data.departments.filter(d => d.myClearance !== null && d.status === "active");
    const current = home.departmentId ?? none;
    const currentName = data.departments.find(d => d.departmentId === home.departmentId)?.name ?? t.none;
    return (
      <div key={key(home.principal)} className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm">{label}</span>
        <Select value={current} onValueChange={(value) => { if (value && value !== current) void save(home.principal, value); }}>
          <SelectTrigger aria-label={label} className="min-h-11 w-56"><SelectValue>{currentName}</SelectValue></SelectTrigger>
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
      <div>
        <h3 className="font-medium">{t.title}</h3>
        <p className="text-sm text-muted-foreground">{t.summary}</p>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {mine ? picker(mine, t.mine) : null}
      {assistants.length > 0 ? <p className="pt-2 text-xs font-medium uppercase text-muted-foreground">{t.assistants}</p> : null}
      {assistants.map(home => picker(home, names.get(key(home.principal)) ?? dictionary.departmentAccess.assistant))}
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
