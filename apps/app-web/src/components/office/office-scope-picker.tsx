"use client";

/** Creation intent only. The writer reauthorizes the selected destination. [COMP:app-web/office-navigation] */
import { useEffect, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useT } from "@/lib/i18n/client";
import { useOptionalWorkspaceContext } from "@/lib/workspace-context";
import { fetchDepartments, DEPARTMENTS_CHANGED_EVENT, type DepartmentClearance, type DepartmentDirectoryEntry } from "@/lib/api/departments";

export type OfficeCreationScope = {
  destination: { kind: "department"; departmentId: string } | { kind: "general" };
  sensitivity: DepartmentClearance;
};
const tiers = ["public", "internal", "confidential"] as const;

export function OfficeScopePicker({workspaceId, onChange, minimumSensitivity, restricting = false}: {workspaceId:string; minimumSensitivity?:DepartmentClearance; restricting?:boolean; onChange:(scope:OfficeCreationScope|null)=>void}) {
  const t = useT().office;
  const workspace = useOptionalWorkspaceContext();
  const viewerId = workspace?.workspaceId === workspaceId ? workspace.me.id : "";
  const [departments, setDepartments] = useState<DepartmentDirectoryEntry[] | null>(null);
  const [destination, setDestination] = useState("");
  const [sensitivity, setSensitivity] = useState<DepartmentClearance>(minimumSensitivity ?? "internal");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true, revision = 0;
    const refresh = () => {
      const request = ++revision;
      setDepartments(null);
      setFailed(false);
      onChange(null);
      void fetchDepartments(workspaceId).then(result => {
        if (!active || request !== revision) return;
        const choices = result.departments.filter(d => d.status === "active" && d.myClearance !== null);
        setDepartments(choices);
        const home = result.homes.find(h => h.principal.kind === "user" && h.principal.id === viewerId)?.departmentId;
        setDestination(previous => previous === "general" || choices.some(d => d.departmentId === previous) ? previous : home && choices.some(d => d.departmentId === home) ? home : "");
      }).catch(() => { if (active && request === revision) setFailed(true); });
    };
    refresh();
    window.addEventListener(DEPARTMENTS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener(DEPARTMENTS_CHANGED_EVENT, refresh); window.removeEventListener("focus", refresh); };
  }, [workspaceId, viewerId, onChange]);
  const clearance = departments?.find(d => d.departmentId === destination)?.myClearance;
  const allowedTiers = tiers.filter(tier => (!minimumSensitivity || tiers.indexOf(tier) >= tiers.indexOf(minimumSensitivity)) && (destination === "general" || clearance && tiers.indexOf(tier) <= tiers.indexOf(clearance)));
  const valid = departments !== null && destination !== "" && allowedTiers.includes(sensitivity);
  useEffect(() => {
    onChange(valid ? {destination: destination === "general" ? {kind:"general"} : {kind:"department", departmentId:destination}, sensitivity} : null);
  }, [valid, destination, sensitivity, onChange]);
  return <fieldset className="space-y-3 rounded-lg border p-4">
    <legend className="px-1 text-sm font-medium">{t.departmentAccess}</legend>
    <p className="text-sm text-muted-foreground">{t.departmentAccessDescription}</p>
    <SearchableSelect value={destination} onValueChange={setDestination} disabled={!departments}
      items={[{value:"general",label:restricting ? t.keepDepartments : t.generalDepartment}, ...(departments ?? []).map(d => ({value:d.departmentId,label:d.name}))]}
      aria-label={t.departmentLabel} placeholder={t.departmentLabel} searchPlaceholder={t.departmentLabel} emptyMessage={t.noDepartments}/>
    <SearchableSelect value={sensitivity} onValueChange={value => setSensitivity(value as DepartmentClearance)} disabled={!departments || !destination}
      items={allowedTiers.map(tier => ({value:tier,label:{public:t.sensitivityPublic,internal:t.sensitivityInternal,confidential:t.sensitivityConfidential}[tier]}))}
      aria-label={t.sensitivityLabel} searchPlaceholder={t.sensitivityLabel} emptyMessage={t.noDepartments}/>
    {failed ? <p role="alert" className="text-sm text-destructive">{t.loadFailed}</p> : null}
  </fieldset>;
}
