"use client";

/**
 * Organization -> Departments: who reads a department and how deep (permission
 * model v2), and home departments. Calls the same commands as Brian's
 * `manageDepartments` tool (D25). Spec: docs/architecture/features/workspace-access.md
 * -> "Department management and home departments (v2, migration 651)".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Crown, ShieldAlert, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
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
      : t.errorGeneric;
  };
}

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

  const run = async (change: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await change(); } catch (cause) { setError(errorCopy(cause)); reload(); reloadDirectory(); } finally { setBusy(false); }
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

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-medium">{t.title}</h3>
        <p className="text-sm text-muted-foreground">{canManage ? t.summary : wsOwnerOutside ? t.notMember : t.readOnly}</p>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {wsOwnerOutside ? (
        <Button variant="outline" size="sm" className="min-h-11" disabled={busy} onClick={() => void (async () => {
          const ok = await confirmDialog({ title: t.breakGlassTitle, description: t.breakGlassDescription, confirmLabel: t.breakGlass, variant: "destructive" });
          if (!ok) return;
          const reason = (await promptDialog({ title: t.breakGlassReason }))?.trim();
          if (reason) await run(() => breakGlassDepartment(workspaceId, departmentId, reason));
        })()}><ShieldAlert className="size-4" />{t.breakGlass}</Button>
      ) : edges.length === 0 ? <p className="text-sm text-muted-foreground">{t.empty}</p> : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {edges.map(edge => {
            const isOwner = edge.principal.kind === "user" && owners.has(edge.principal.id);
            const name = label(edge.principal);
            return (
              <li key={key(edge.principal)} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{name}</span>
                    <span className="text-xs text-muted-foreground">{edge.principal.kind === "user" ? t.person : t.assistant}</span>
                    {isOwner ? <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"><Crown className="size-3" />{t.owner}</span> : null}
                    {edge.origin === "migrated" ? <span title={t.carriedOverHint} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{t.carriedOver}</span> : null}
                  </div>
                  {edge.expiresAt ? <p className="text-xs text-muted-foreground">{format(t.expires, { date: new Date(edge.expiresAt).toLocaleDateString() })}</p> : null}
                </div>
                {canManage && !isOwner ? (
                  <Select value={edge.clearance} onValueChange={(value) => { if (value && value !== edge.clearance) void run(() => setDepartmentEdge(workspaceId, departmentId, { principal: edge.principal, clearance: value as DepartmentClearance, expiresAt: edge.expiresAt, expectedRevision: entry?.revision })); }}>
                    <SelectTrigger aria-label={format(t.clearanceLabel, { name })} className="min-h-11 w-40" disabled={busy}>
                      <SelectValue>{clearanceLabel(edge.clearance)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>{CLEARANCES.map(c => <SelectItem key={c} value={c}>{clearanceLabel(c)}</SelectItem>)}</SelectContent>
                  </Select>
                ) : <span className="text-sm">{clearanceLabel(edge.clearance)}</span>}
                {canManage && edge.principal.kind === "user" ? (
                  <Button variant="ghost" size="sm" className="min-h-11" disabled={busy || (isOwner && edge.principal.id === me.id && owners.size <= 1)} onClick={() => void run(() => isOwner
                    ? removeDepartmentOwner(workspaceId, departmentId, edge.principal.id, entry?.revision)
                    : addDepartmentOwner(workspaceId, departmentId, edge.principal.id, entry?.revision))}>
                    <Crown className="size-4" />{isOwner ? t.removeOwner : t.makeOwner}
                  </Button>
                ) : null}
                {canManage && !isOwner ? (
                  <Button variant="ghost" size="sm" className="min-h-11 text-destructive hover:text-destructive" disabled={busy} onClick={() => void (async () => {
                    const ok = await confirmDialog({ title: t.removeTitle, description: format(t.removeDescription, { name }), confirmLabel: t.remove, variant: "destructive" });
                    if (ok) await run(() => removeDepartmentEdge(workspaceId, departmentId, { principal: edge.principal, expectedRevision: entry?.revision }));
                  })()}><Trash2 className="size-4" />{t.remove}</Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {canManage && candidates.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={adding} onValueChange={(value) => setAdding(value ?? "")}>
            <SelectTrigger aria-label={t.addPlaceholder} className="min-h-11 min-w-56 flex-1" disabled={busy}>
              <SelectValue>{adding ? names.get(adding) ?? adding : t.addPlaceholder}</SelectValue>
            </SelectTrigger>
            <SelectContent>{candidates.map(p => <SelectItem key={key(p)} value={key(p)}>{`${label(p)} (${p.kind === "user" ? t.person : t.assistant})`}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="sm" className="min-h-11" disabled={busy || !adding} onClick={() => {
            const [kind, id] = adding.split(":") as [DepartmentPrincipal["kind"], string];
            setAdding("");
            void run(() => setDepartmentEdge(workspaceId, departmentId, { principal: { kind, id }, clearance: "internal", expectedRevision: entry?.revision }));
          }}><UserPlus className="size-4" />{t.add}</Button>
        </div>
      ) : null}
    </div>
  );
}

/** Your home department, and those of assistants you may configure. */
export function HomeDepartmentControls() {
  const { workspaceId, me } = useWorkspaceContext();
  const dictionary = useT(), t = dictionary.homeDepartment;
  const errorCopy = useErrorCopy();
  const { data, reload } = useDirectory(workspaceId);
  const { names } = useNames(workspaceId);
  const [error, setError] = useState<string | null>(null);
  if (!data) return <div aria-hidden className="h-16 animate-pulse rounded-lg bg-muted/40" />;
  const memberOf = data.departments.filter(d => d.myClearance !== null && d.status === "active");
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
