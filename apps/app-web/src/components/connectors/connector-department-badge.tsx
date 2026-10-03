"use client";

/**
 * Connector department badge: the connector's audience (who may see it in
 * Studio and receive its tools), picked inline from the header the same way
 * an assistant's clearance is. General means every workspace member.
 * Spec: docs/architecture/integrations/mcp.md -> "Connector departments are an
 * audience". [COMP:app-web/connector-department-badge]
 */
import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import { fetchDepartments } from "@/lib/api/departments";
import { getConnectorContext, listContextTeams, updateConnectorContext } from "@/lib/api/context-scopes";

const GENERAL = "__general__";

type Option = { id: string; name: string };

function DepartmentPill({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M2.5 13.5v-9l5-2 5 2v9M6 13.5v-3h4v3M5.5 6.5h1M9.5 6.5h1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {name}
    </span>
  );
}

export function ConnectorDepartmentBadge({
  workspaceId,
  instanceId,
}: {
  workspaceId: string;
  instanceId: string;
}) {
  const t = useT().contextScope;
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [options, setOptions] = useState<Option[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void Promise.all([
      getConnectorContext(workspaceId, instanceId),
      fetchDepartments(workspaceId).catch(() => ({ departments: [] })),
      listContextTeams(workspaceId).catch(() => []),
    ])
      .then(([context, directory, teams]) => {
        if (cancelled) return;
        setDepartmentId(context.contextGroupId);
        setCanEdit(context.canEdit);
        setOptions(directory.departments
          .filter((d) => d.status === "active")
          .map((d) => ({ id: d.departmentId, name: d.name })));
        setNames(Object.fromEntries([
          ...teams.map((team) => [team.id, team.name] as const),
          ...directory.departments.map((d) => [d.departmentId, d.name] as const),
        ]));
        setLoaded(true);
      })
      // A connector this viewer cannot see answers 404: show no badge.
      .catch(() => { if (!cancelled) setLoaded(false); });
    return () => { cancelled = true; };
  }, [workspaceId, instanceId]);

  if (!loaded) return null;
  const label = departmentId ? names[departmentId] ?? t.departmentUnknown : t.departmentGeneral;

  async function change(next: string) {
    const value = next === GENERAL ? null : next;
    if (value === departmentId) return;
    const previous = departmentId;
    setDepartmentId(value);
    setSaving(true);
    setFailed(false);
    try {
      await updateConnectorContext(workspaceId, instanceId, { contextGroupId: value });
    } catch {
      setDepartmentId(previous);
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  if (!canEdit) return <DepartmentPill name={label} />;
  const choices = departmentId && !options.some((o) => o.id === departmentId)
    ? [...options, { id: departmentId, name: label }]
    : options;
  return (
    <span className="inline-flex items-center gap-1">
    <Select value={departmentId ?? GENERAL} onValueChange={(v) => void change(String(v))} disabled={saving}>
      <SelectTrigger
        size="sm"
        aria-label={t.departmentAriaLabel}
        className="max-sm:min-h-11 w-auto gap-1 border-transparent bg-transparent px-1 py-0 text-[16px] hover:bg-muted/50 md:text-sm"
      >
        <SelectValue>
          <DepartmentPill name={label} />
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value={GENERAL}><DepartmentPill name={t.departmentGeneral} /></SelectItem>
        {choices.map((o) => (
          <SelectItem key={o.id} value={o.id}><DepartmentPill name={o.name} /></SelectItem>
        ))}
      </SelectContent>
    </Select>
    {failed && <span className="text-[11px] text-destructive">{t.departmentUpdateFailed}</span>}
    </span>
  );
}
