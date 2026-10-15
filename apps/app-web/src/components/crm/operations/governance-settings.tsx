"use client";

/**
 * CRM configuration -> Governance: the four review policies (client changes,
 * engagement changes, commercial values, billing requests) and the two
 * engagement catalogs (service categories, work statuses).
 *
 * A policy is one of a finite set of modes; reviewers are owners and admins,
 * or members of a named department. Catalog keys are stable: once saved a key
 * can be relabelled or archived, never removed. Owners and admins edit; every
 * other member sees the same content read-only.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Governed engagement and billing".
 * [COMP:app-web/crm-commercial-operations]
 */

import { useEffect, useState } from "react";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CrmCommercialCommand } from "@/lib/api/crm-commercial";
import { fetchDepartments, type DepartmentDirectoryEntry } from "@/lib/api/departments";
import {
  CRM_GOVERNANCE_SUBJECTS,
  getCrmGovernance,
  type CrmCatalogEntry,
  type CrmCatalogKind,
  type CrmDirectRole,
  type CrmGovernance,
  type CrmGovernanceSubject,
  type CrmReviewMode,
  type CrmReviewPolicy,
} from "@/lib/api/crm-governed";
import { newCrmOperationId } from "@/lib/api/crm-references";
import { useT } from "@/lib/i18n/client";
import {
  CommercialInput,
  CommercialSelect,
  IssueList,
  RefusalLine,
  STABLE_KEY_PATTERN,
  UncertainWrite,
  useCommercialCommand,
} from "./commercial-shared";
import { describeGovernedRefusal, type GovernedCopy } from "./governed-shared";

const ANY_REVIEWER = "__any__";
const DIRECT_ROLES: readonly CrmDirectRole[] = ["owner", "admin", "member"];

export function CrmGovernanceSettings({ workspaceId, canConfigure }: { workspaceId: string; canConfigure: boolean }) {
  const g = useT().crmPage.governed;
  const [governance, setGovernance] = useState<CrmGovernance | null>(null);
  const [departments, setDepartments] = useState<DepartmentDirectoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void Promise.all([
      getCrmGovernance(workspaceId),
      fetchDepartments(workspaceId).then((body) => body.departments).catch(() => null),
    ])
      .then(([found, directory]) => {
        if (cancelled) return;
        setGovernance(found);
        setDepartments(directory);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, attempt]);

  const reload = () => setAttempt((value) => value + 1);

  return (
    <section className="border-t border-border pt-5" data-crm-governance-settings>
      <div className="mb-3 min-w-0">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold"><ShieldCheck className="size-3.5" aria-hidden />{g.settingsTitle}</h3>
        <p className="text-xs text-muted-foreground">{g.settingsDescription}</p>
      </div>
      {!canConfigure && <p className="mb-2 text-xs text-muted-foreground">{g.settingsReadOnly}</p>}
      {failed ? (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>{g.loadFailed}</span>
          <Button size="sm" variant="ghost" onClick={reload}>{g.retry}</Button>
        </div>
      ) : !governance ? (
        <div className="text-xs text-muted-foreground">{g.loading}</div>
      ) : (
        <div className="space-y-6">
          <div data-governance-policies>
            <h4 className="text-xs font-semibold">{g.policiesTitle}</h4>
            <p className="mb-2 text-[11px] text-muted-foreground">{g.policiesHelp}</p>
            <ul className="divide-y divide-border">
              {CRM_GOVERNANCE_SUBJECTS.map((subject) => {
                const row = governance.policies.find((item) => item.subject === subject);
                if (!row) return null;
                return (
                  <PolicyRow key={subject} workspaceId={workspaceId} subject={subject} policy={row.policy} version={row.version}
                    isDefault={row.default === true} departments={departments} canConfigure={canConfigure} onSaved={reload} />
                );
              })}
            </ul>
          </div>
          {(["service_category", "work_status"] as const).map((catalog) => {
            const row = governance.catalogs.find((item) => item.catalog === catalog) ?? { catalog, entries: [], version: 0 };
            return (
              <CatalogEditor key={catalog} workspaceId={workspaceId} catalog={catalog} entries={row.entries} version={row.version}
                canConfigure={canConfigure} onSaved={reload} />
            );
          })}
        </div>
      )}
    </section>
  );
}

function departmentName(departments: DepartmentDirectoryEntry[] | null, id: string | null, g: GovernedCopy): string {
  if (!id) return g.anyOwnerOrAdmin;
  return departments?.find((department) => department.departmentId === id)?.name ?? g.departmentId.replace("{id}", id);
}

function PolicyRow({ workspaceId, subject, policy, version, isDefault, departments, canConfigure, onSaved }: {
  workspaceId: string;
  subject: CrmGovernanceSubject;
  policy: CrmReviewPolicy;
  version: number;
  isDefault: boolean;
  departments: DepartmentDirectoryEntry[] | null;
  canConfigure: boolean;
  onSaved: () => void;
}) {
  const g = useT().crmPage.governed;
  const commercial = useT().crmPage.commercial;
  const [draft, setDraft] = useState<CrmReviewPolicy>(policy);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;
  useEffect(() => { setDraft(policy); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps -- re-sync only when a new version is read
  const modes: CrmReviewMode[] = subject === "billing_request" ? ["direct", "single_review", "reviewer_then_finance"] : ["direct", "single_review"];
  const changed = JSON.stringify(draft) !== JSON.stringify(policy);
  const activeDepartments = (departments ?? []).filter((department) => department.status === "active");
  const departmentOptions = [{ value: ANY_REVIEWER, label: g.anyOwnerOrAdmin }, ...activeDepartments.map((department) => ({ value: department.departmentId, label: department.name }))];

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    setSaved(false);
    const outcome = await writer.run(command);
    if (outcome.ok) { setSaved(true); onSaved(); return; }
    if (!outcome.error.uncertain) setRefusal(describeGovernedRefusal(outcome.error, g, commercial));
  }

  function save() {
    if (!changed || locked) return;
    void send({
      kind: "save_governance_policy",
      operationId: newCrmOperationId(),
      subject,
      expectedVersion: version,
      policy: { ...draft, financeDepartmentId: draft.mode === "reviewer_then_finance" ? draft.financeDepartmentId : null },
    });
  }

  const toggleRole = (role: CrmDirectRole) => setDraft((current) => ({
    ...current,
    directRoles: current.directRoles.includes(role) ? current.directRoles.filter((item) => item !== role) : [...current.directRoles, role],
  }));

  return (
    <li className="min-w-0 space-y-2 py-3" data-governance-policy={subject}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{g.policySubjects[subject]}</span>
        {isDefault && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{g.defaultPolicy}</span>}
      </div>
      <p className="text-[11px] text-muted-foreground">{g.modeHelp[draft.mode]}</p>
      {canConfigure ? (
        <fieldset disabled={locked} className="grid min-w-0 gap-2 sm:grid-cols-2">
          <CommercialSelect label={g.mode} value={draft.mode}
            options={modes.map((mode) => ({ value: mode, label: g.modes[mode] }))}
            onChange={(mode) => setDraft((current) => ({ ...current, mode: mode as CrmReviewMode }))} />
          <div className="min-w-0">
            <div className="mb-1 text-xs text-muted-foreground">{g.directRoles}</div>
            <div className="flex flex-wrap gap-1">
              {DIRECT_ROLES.map((role) => (
                <Button key={role} size="xs" variant={draft.directRoles.includes(role) ? "default" : "outline"} className="max-md:min-h-11"
                  aria-pressed={draft.directRoles.includes(role)} onClick={() => toggleRole(role)}>
                  {g.roles[role]}
                </Button>
              ))}
            </div>
          </div>
          {departments ? (
            <CommercialSelect label={g.reviewerDepartment} value={draft.reviewerDepartmentId ?? ANY_REVIEWER} options={departmentOptions}
              onChange={(value) => setDraft((current) => ({ ...current, reviewerDepartmentId: value === ANY_REVIEWER ? null : value }))} />
          ) : (
            <ReadOnlyFact label={g.reviewerDepartment} value={departmentName(departments, draft.reviewerDepartmentId, g)} />
          )}
          {draft.mode === "reviewer_then_finance" && (departments ? (
            <CommercialSelect label={g.financeDepartment} value={draft.financeDepartmentId ?? ANY_REVIEWER} options={departmentOptions}
              onChange={(value) => setDraft((current) => ({ ...current, financeDepartmentId: value === ANY_REVIEWER ? null : value }))} />
          ) : (
            <ReadOnlyFact label={g.financeDepartment} value={departmentName(departments, draft.financeDepartmentId, g)} />
          ))}
          <div className="min-w-0 sm:col-span-2">
            <Button size="sm" variant={draft.allowSelfReview ? "default" : "outline"} aria-pressed={draft.allowSelfReview}
              onClick={() => setDraft((current) => ({ ...current, allowSelfReview: !current.allowSelfReview }))}>
              {g.allowSelfReview}
            </Button>
            <p className="mt-1 text-[11px] text-muted-foreground">{g.allowSelfReviewHelp}</p>
          </div>
        </fieldset>
      ) : (
        <dl className="grid min-w-0 gap-2 text-xs sm:grid-cols-2">
          <ReadOnlyFact label={g.mode} value={g.modes[policy.mode]} />
          <ReadOnlyFact label={g.directRoles} value={policy.directRoles.length ? policy.directRoles.map((role) => g.roles[role]).join(", ") : g.noDirectRoles} />
          <ReadOnlyFact label={g.reviewerDepartment} value={departmentName(departments, policy.reviewerDepartmentId, g)} />
          {policy.mode === "reviewer_then_finance" && <ReadOnlyFact label={g.financeDepartment} value={departmentName(departments, policy.financeDepartmentId, g)} />}
          <ReadOnlyFact label={g.allowSelfReview} value={policy.allowSelfReview ? g.yes : g.no} />
        </dl>
      )}
      {saved && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{g.policySaved}</p>}
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={onSaved} />
      {canConfigure && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={!changed || writer.busy} onClick={() => setDraft(policy)}>{g.reset}</Button>
          <Button size="sm" disabled={!changed || locked} onClick={save}>{writer.busy ? g.saving : g.savePolicy}</Button>
        </div>
      )}
    </li>
  );
}

function ReadOnlyFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 text-xs">
      <dt className="mb-1 text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}

type EntryRow = CrmCatalogEntry & { rowId: number; saved: boolean };

let entrySequence = 0;
const nextEntryId = () => { entrySequence += 1; return entrySequence; };

function CatalogEditor({ workspaceId, catalog, entries, version, canConfigure, onSaved }: {
  workspaceId: string;
  catalog: CrmCatalogKind;
  entries: CrmCatalogEntry[];
  version: number;
  canConfigure: boolean;
  onSaved: () => void;
}) {
  const g = useT().crmPage.governed;
  const commercial = useT().crmPage.commercial;
  const [rows, setRows] = useState<EntryRow[]>(() => entries.map((entry) => ({ ...entry, rowId: nextEntryId(), saved: true })));
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;

  useEffect(() => {
    setRows(entries.map((entry) => ({ ...entry, rowId: nextEntryId(), saved: true })));
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps -- re-sync only when a new version is read

  const next = rows.map(({ key, label, archived }) => ({ key: key.trim(), label: label.trim(), archived }));
  const changed = JSON.stringify(next) !== JSON.stringify(entries.map(({ key, label, archived }) => ({ key, label, archived })));
  const issues: string[] = [];
  if (rows.some((row) => !STABLE_KEY_PATTERN.test(row.key.trim()))) issues.push(g.issues.catalogKey);
  if (rows.some((row) => !row.label.trim())) issues.push(g.issues.catalogLabel);
  if (new Set(next.map((row) => row.key)).size !== next.length) issues.push(g.issues.catalogDuplicate);
  if (rows.length === 0) issues.push(g.issues.catalogEmpty);

  const update = (rowId: number, patch: Partial<EntryRow>) => setRows((current) => current.map((row) => row.rowId === rowId ? { ...row, ...patch } : row));

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    setSaved(false);
    const outcome = await writer.run(command);
    if (outcome.ok) { setSaved(true); onSaved(); return; }
    if (!outcome.error.uncertain) setRefusal(describeGovernedRefusal(outcome.error, g, commercial));
  }

  function save() {
    if (!changed || issues.length || locked) return;
    void send({ kind: "save_engagement_catalog", operationId: newCrmOperationId(), catalog, expectedVersion: version, entries: next });
  }

  return (
    <div className="min-w-0" data-governance-catalog={catalog}>
      <h4 className="text-xs font-semibold">{g.catalogs[catalog]}</h4>
      <p className="mb-2 text-[11px] text-muted-foreground">{g.catalogHelp}</p>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">{g.catalogEmpty}</p>}
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.rowId} className={`grid min-w-0 items-end gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] ${row.archived ? "opacity-75" : ""}`}
            data-catalog-entry={row.key || "new"}>
            {row.saved || !canConfigure ? (
              <div className="min-w-0 text-xs">
                <span className="mb-1 block text-muted-foreground">{g.catalogKey}</span>
                <span className="block break-all py-2 font-mono">{row.key}</span>
              </div>
            ) : (
              <CommercialInput label={g.catalogKey} value={row.key} maxLength={63} onChange={(key) => update(row.rowId, { key: key.trim().toLowerCase() })} />
            )}
            {canConfigure ? (
              <CommercialInput label={g.catalogLabel.replace("{key}", row.key || g.newEntry)} value={row.label} maxLength={200}
                disabled={locked} onChange={(label) => update(row.rowId, { label })} />
            ) : (
              <div className="min-w-0 text-xs">
                <span className="mb-1 block text-muted-foreground">{g.catalogLabelPlain}</span>
                <span className="block break-words py-2">{row.label}</span>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1">
              {row.archived && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">{g.archived}</span>}
              {canConfigure && (row.saved ? (
                <Button size="xs" variant="ghost" className="max-md:min-h-11" disabled={locked}
                  onClick={() => update(row.rowId, { archived: !row.archived })}>
                  {row.archived ? g.unarchive : g.archive}
                </Button>
              ) : (
                <Button size="icon-xs" variant="ghost" className="max-md:size-11" aria-label={g.removeNewEntry} disabled={locked}
                  onClick={() => setRows((current) => current.filter((item) => item.rowId !== row.rowId))}>
                  <Trash2 aria-hidden />
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {canConfigure && (
        <>
          <Button size="sm" variant="outline" className="mt-2" disabled={locked || rows.length >= 200}
            onClick={() => setRows((current) => [...current, { key: "", label: "", archived: false, rowId: nextEntryId(), saved: false }])}>
            <Plus aria-hidden />{g.addEntry}
          </Button>
          <IssueList issues={changed ? issues : []} />
          {saved && <p role="status" className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">{g.catalogSaved}</p>}
          <RefusalLine text={refusal} />
          <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={onSaved} />
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Button size="sm" disabled={!changed || issues.length > 0 || locked} onClick={save}>{writer.busy ? g.saving : g.saveCatalog}</Button>
          </div>
        </>
      )}
    </div>
  );
}
