"use client";

/**
 * Shared pieces of the commercial-context UI: the write lane (one operation id
 * per intent, reused verbatim on an uncertain retry), localized refusals, the
 * typed value display, and the editor that accepts a new seller, account or
 * agreement profile version against the version the user read.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Commercial context".
 * [COMP:app-web/crm-commercial-operations]
 */

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CRM_COMMERCIAL_FIELD_TYPES,
  executeCrmCommercialCommand,
  type CrmCommercialCommand,
  type CrmCommercialCommandResult,
  type CrmCommercialEvidenceKind,
  type CrmCommercialFieldEntry,
  type CrmCommercialFieldType,
  type CrmCommercialFields,
  type CrmCommercialProfile,
  type CrmCommercialProfileOwner,
  type CrmCommercialReferenceKind,
  type CrmCommercialResolution,
  type CrmResolutionQuestion,
  type CrmSensitivity,
} from "@/lib/api/crm-commercial";
import { CrmReferenceRequestError, newCrmOperationId } from "@/lib/api/crm-references";
import { useT } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import { referenceInputClass } from "./record-references";

export type CommercialCopy = Dictionary["crmPage"]["commercial"];

const commercialTextareaClass =
  "min-h-24 w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-[16px] outline-none disabled:opacity-60 md:text-sm";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STABLE_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_PATTERN = /^-?\d{1,18}(\.\d{1,6})?$/;
const REFERENCE_KINDS: readonly CrmCommercialReferenceKind[] = ["company", "deal", "person", "account", "seller", "page", "file"];
const EVIDENCE_KINDS: readonly CrmCommercialEvidenceKind[] = ["manual", "page", "file", "office_artifact", "external"];
const SENSITIVITY_RANK: Record<CrmSensitivity, number> = { public: 0, internal: 1, confidential: 2 };

export const isCalendarDate = (value: string) => DATE_PATTERN.test(value)
  && !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

/** A localized, truthful sentence for a definite refusal. */
export function describeCommercialRefusal(error: CrmReferenceRequestError, t: CommercialCopy): string {
  const reason = error.reason;
  if (reason === "classification_broader_than_source") {
    const minimum = error.details.minimum;
    const label = typeof minimum === "string" && minimum in t.sensitivityLabels
      ? t.sensitivityLabels[minimum as CrmSensitivity]
      : String(minimum ?? "");
    return t.refusals.classification_broader_than_source.replace("{minimum}", label);
  }
  if (reason === "stale_version") {
    return t.refusals.stale_version.replace("{version}", String(error.details.currentVersion ?? ""));
  }
  if (reason && reason in t.refusals) return t.refusals[reason as keyof CommercialCopy["refusals"]];
  if (error.code === "not_authorized" || error.status === 403) return t.notAuthorized;
  if (error.code === "not_found" || error.status === 404) return t.unavailable;
  return error.message && error.message !== error.code ? `${t.writeFailed} ${error.message}` : t.writeFailed;
}

/**
 * One write lane. A new intent passes a command with a fresh operation id; a
 * failure the server never answered keeps that exact command so Retry resends
 * it unchanged. A definite answer clears it.
 */
export function useCommercialCommand(workspaceId: string) {
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState<CrmCommercialCommand | null>(null);
  async function run(command: CrmCommercialCommand): Promise<
    { ok: true; result: CrmCommercialCommandResult } | { ok: false; error: CrmReferenceRequestError }
  > {
    setBusy(true);
    try {
      const result = await executeCrmCommercialCommand(workspaceId, command);
      setUncertain(null);
      return { ok: true, result };
    } catch (cause) {
      const error = cause instanceof CrmReferenceRequestError ? cause : new CrmReferenceRequestError("network_error", null);
      setUncertain(error.uncertain ? command : null);
      return { ok: false, error };
    } finally {
      setBusy(false);
    }
  }
  return { busy, uncertain, run, discard: () => setUncertain(null) };
}

type CommercialWriter = ReturnType<typeof useCommercialCommand>;

export function UncertainWrite({ writer, onRetry, onDiscard }: {
  writer: CommercialWriter;
  onRetry: (command: CrmCommercialCommand) => void;
  onDiscard: () => void;
}) {
  const t = useT().crmPage.commercial;
  if (!writer.uncertain) return null;
  const command = writer.uncertain;
  return (
    <div role="alert" className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
      <p>{t.uncertainWrite}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={writer.busy} onClick={() => onRetry(command)}>{t.retryWrite}</Button>
        <Button size="sm" variant="ghost" disabled={writer.busy} onClick={() => { writer.discard(); onDiscard(); }}>{t.discardAndReload}</Button>
      </div>
    </div>
  );
}

export function RefusalLine({ text }: { text: string | null }) {
  if (!text) return null;
  return <p role="alert" className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{text}</p>;
}

export function IssueList({ issues }: { issues: string[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11px] text-amber-700 dark:text-amber-300" data-commercial-issues>
      {issues.map((issue) => <li key={issue}>{issue}</li>)}
    </ul>
  );
}

export function CommercialInput({ label, value, onChange, type = "text", disabled, maxLength }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "date";
  disabled?: boolean;
  maxLength?: number;
}) {
  return (
    <label className="block min-w-0 text-xs">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <input type={type} value={value} disabled={disabled} maxLength={maxLength} aria-label={label}
        onChange={(event) => onChange(event.target.value)} className={referenceInputClass} />
    </label>
  );
}

export function CommercialTextarea({ label, value, onChange, maxLength }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  return (
    <label className="block min-w-0 text-xs">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <textarea value={value} maxLength={maxLength} aria-label={label}
        onChange={(event) => onChange(event.target.value)} className={commercialTextareaClass} />
    </label>
  );
}

export function CommercialSelect({ label, value, options, onChange, placeholder, disabled }: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block min-w-0 text-xs">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <Select items={options} value={value || null} disabled={disabled} onValueChange={(next) => { if (typeof next === "string") onChange(next); }}>
        <SelectTrigger className="h-11 w-full md:h-9" aria-label={label}><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
      </Select>
    </label>
  );
}

export function SensitivityBadge({ sensitivity, baseline }: { sensitivity: CrmSensitivity; baseline?: CrmSensitivity }) {
  const t = useT().crmPage.commercial;
  const stricter = baseline !== undefined && SENSITIVITY_RANK[sensitivity] > SENSITIVITY_RANK[baseline];
  return (
    <span
      data-commercial-sensitivity={sensitivity}
      data-stricter={stricter ? "true" : undefined}
      className={sensitivity === "confidential"
        ? "rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200"
        : "rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"}
    >
      {t.sensitivityLabels[sensitivity]}
    </span>
  );
}

export function sensitivityOptions(t: CommercialCopy, includeDefault: boolean) {
  return [
    ...(includeDefault ? [{ value: "default", label: t.sensitivityDefault }] : []),
    ...(["public", "internal", "confidential"] as const).map((value) => ({ value, label: t.sensitivityLabels[value] })),
  ];
}

/** Human rendering of one typed value. Absent is "missing"; null is a recorded "does not apply". */
function formatCommercialValue(value: unknown, t: CommercialCopy): string {
  if (value === undefined) return t.missingValue;
  if (value === null) return t.doesNotApply;
  if (typeof value === "boolean") return value ? t.yes : t.no;
  if (typeof value === "object" && value && "kind" in value && "id" in value) {
    const reference = value as { kind: string; id: string };
    const kind = reference.kind in t.referenceKinds ? t.referenceKinds[reference.kind as CrmCommercialReferenceKind] : reference.kind;
    return `${kind} ${reference.id}`;
  }
  return String(value);
}

type QuestionGroup = keyof CommercialCopy["questionGroups"];

function questionGroup(question: CrmResolutionQuestion): QuestionGroup {
  if (question.kind === "conflict") return "conflict";
  if (question.kind === "review_required") return "review";
  return question.requiredFor === "draft" ? "draft" : "issue";
}

function sourceLabel(source: NonNullable<CrmCommercialResolution["fields"][string]["source"]>, t: CommercialCopy): string {
  return t.sourceLabels[source.kind].replace("{version}", String(source.version ?? ""));
}

/** Each resolved field with its value and the accepted source that filled it. */
export function ResolvedFieldList({ fields, labelFor }: {
  fields: CrmCommercialResolution["fields"];
  labelFor: (fieldKey: string) => string;
}) {
  const t = useT().crmPage.commercial;
  return (
    <dl className="mt-2 divide-y divide-border/60 text-xs">
      {Object.values(fields).map((field) => (
        <div key={field.fieldKey} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5" data-resolved-field={field.fieldKey}>
          <dt className="min-w-0">
            <span className="font-medium">{labelFor(field.fieldKey)}</span>
            <span className="ml-1 font-mono text-[11px] text-muted-foreground">{field.fieldKey}</span>
          </dt>
          <dd className="flex flex-wrap items-baseline gap-2">
            <span className={field.value === undefined || field.value === null ? "italic text-muted-foreground" : ""}>
              {formatCommercialValue(field.value, t)}
            </span>
            <span className="text-[11px] text-muted-foreground" data-resolved-source>
              {field.source ? sourceLabel(field.source, t) : t.noSource}
              {field.overridden ? ` · ${t.overridden}` : ""}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Open questions grouped by what they block: draft, issue, conflicts, review. */
export function QuestionGroups({ questions }: { questions: CrmResolutionQuestion[] }) {
  const t = useT().crmPage.commercial;
  const groups = new Map<QuestionGroup, CrmResolutionQuestion[]>();
  for (const question of questions) {
    const group = questionGroup(question);
    groups.set(group, [...(groups.get(group) ?? []), question]);
  }
  if (groups.size === 0) return <p className="mt-2 text-[11px] text-muted-foreground">{t.noQuestions}</p>;
  return (
    <>
      {(["draft", "issue", "conflict", "review"] as const).filter((group) => groups.has(group)).map((group) => (
        <div key={group} className="mt-2" data-question-group={group}>
          <div className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">{t.questionGroups[group]}</div>
          <ul className="mt-0.5 list-disc pl-5 text-xs">
            {groups.get(group)!.map((question) => (
              <li key={`${question.kind}:${question.fieldKey}`}>
                <span className="font-medium">{question.label}</span>: {question.question}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function effectiveLabel(profile: Pick<CrmCommercialProfile, "effectiveFrom" | "effectiveTo">, t: CommercialCopy): string {
  if (!profile.effectiveFrom && !profile.effectiveTo) return t.effectiveAlways;
  return t.effectiveRange
    .replace("{from}", profile.effectiveFrom ?? t.openStart)
    .replace("{to}", profile.effectiveTo ?? t.openEnd);
}

/** An accepted profile version: version, dates, evidence, deals and its typed fields. */
export function ProfileSummary({ profile, showDeals }: { profile: CrmCommercialProfile; showDeals?: boolean }) {
  const t = useT().crmPage.commercial;
  const entries = Object.entries(profile.fields);
  const evidenceKind = typeof profile.evidence.kind === "string" && profile.evidence.kind in t.evidenceKinds
    ? t.evidenceKinds[profile.evidence.kind as CrmCommercialEvidenceKind]
    : null;
  const evidence = [evidenceKind, profile.evidence.id, profile.evidence.revision, profile.evidence.note]
    .filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
  return (
    <div className="min-w-0 text-xs" data-commercial-profile={profile.ownerKind} data-profile-version={profile.version}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        {profile.agreementKey && <span className="font-mono text-foreground/80">{profile.agreementKey}</span>}
        <span className="font-medium text-foreground/80">{t.profileVersion.replace("{version}", String(profile.version))}</span>
        <span>{effectiveLabel(profile, t)}</span>
        <SensitivityBadge sensitivity={profile.sensitivity} />
      </div>
      {showDeals && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {t.agreementDeals.replace("{deals}", profile.dealIds.length ? profile.dealIds.join(", ") : t.allDeals)}
        </div>
      )}
      {evidence && <div className="mt-1 text-[11px] text-muted-foreground">{t.evidence}: {evidence}</div>}
      {entries.length === 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{t.noFields}</p>
      ) : (
        <dl className="mt-1 divide-y divide-border/60">
          {entries.map(([key, entry]) => (
            <div key={key} className="flex flex-wrap justify-between gap-x-3 py-1" data-profile-field={key}>
              <dt className="font-mono text-[11px] text-muted-foreground">{key}</dt>
              <dd className={entry.value === null ? "text-muted-foreground italic" : "text-foreground/90"}>{formatCommercialValue(entry.value, t)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

type FieldRow = {
  rowId: number;
  fieldKey: string;
  type: CrmCommercialFieldType;
  value: string;
  referenceKind: CrmCommercialReferenceKind;
  notApplicable: boolean;
};

let rowSequence = 0;
const nextRowId = () => { rowSequence += 1; return rowSequence; };

function rowFromEntry(fieldKey: string, entry: CrmCommercialFieldEntry): FieldRow {
  const row: FieldRow = { rowId: nextRowId(), fieldKey, type: entry.type, value: "", referenceKind: "company", notApplicable: entry.value === null };
  if (typeof entry.value === "boolean") row.value = entry.value ? "true" : "false";
  else if (typeof entry.value === "string") row.value = entry.value;
  else if (entry.value && typeof entry.value === "object") { row.referenceKind = entry.value.kind; row.value = entry.value.id; }
  return row;
}

function validRowValue(row: FieldRow): boolean {
  if (row.notApplicable) return true;
  const value = row.value.trim();
  switch (row.type) {
    case "string": return value.length > 0 && value.length <= 500;
    case "text": return value.length > 0 && value.length <= 5000;
    case "date": return isCalendarDate(value);
    case "decimal": return DECIMAL_PATTERN.test(value);
    case "currency": return /^[A-Z]{3}$/.test(value);
    case "percent": return DECIMAL_PATTERN.test(value) && Number(value) >= 0 && Number(value) <= 1;
    case "boolean": return value === "true" || value === "false";
    case "reference": return UUID_PATTERN.test(value);
  }
}

function entryFromRow(row: FieldRow): CrmCommercialFieldEntry {
  if (row.notApplicable) return { type: row.type, value: null };
  const value = row.value.trim();
  if (row.type === "boolean") return { type: row.type, value: value === "true" };
  if (row.type === "reference") return { type: row.type, value: { kind: row.referenceKind, id: value } };
  return { type: row.type, value };
}

/**
 * Accept a new profile version. The command names the version the user read
 * (`expectedCurrentVersion`, 0 for the first), so a concurrent acceptance is
 * refused as stale instead of being silently overwritten.
 */
export function ProfileEditor({ workspaceId, owner, current, onAccepted, onCancel }: {
  workspaceId: string;
  owner: { kind: "seller"; sellerKey: string } | { kind: "account"; accountId: string } | { kind: "agreement"; accountId: string };
  current: CrmCommercialProfile | null;
  onAccepted: (version: number | null) => void;
  onCancel: () => void;
}) {
  const t = useT().crmPage.commercial;
  const [rows, setRows] = useState<FieldRow[]>(() => current
    ? Object.entries(current.fields).map(([key, entry]) => rowFromEntry(key, entry))
    : [{ rowId: nextRowId(), fieldKey: "", type: "string", value: "", referenceKind: "company", notApplicable: false }]);
  const [effectiveFrom, setEffectiveFrom] = useState(current?.effectiveFrom ?? "");
  const [effectiveTo, setEffectiveTo] = useState(current?.effectiveTo ?? "");
  const [agreementKey, setAgreementKey] = useState(current?.agreementKey ?? "");
  const [dealIds, setDealIds] = useState((current?.dealIds ?? []).join(", "));
  const [evidenceKind, setEvidenceKind] = useState<CrmCommercialEvidenceKind>("manual");
  const [evidenceId, setEvidenceId] = useState("");
  const [evidenceRevision, setEvidenceRevision] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const writer = useCommercialCommand(workspaceId);
  const locked = writer.busy || writer.uncertain !== null;
  const isAgreement = owner.kind === "agreement";
  const parsedDeals = dealIds.split(",").map((id) => id.trim()).filter(Boolean);

  const issues: string[] = [];
  if (rows.some((row) => !FIELD_KEY_PATTERN.test(row.fieldKey.trim()))) issues.push(t.profileIssues.fieldKey);
  if (new Set(rows.map((row) => row.fieldKey.trim())).size !== rows.length) issues.push(t.profileIssues.duplicateKey);
  if (rows.length > 200) issues.push(t.profileIssues.tooMany);
  for (const row of rows) {
    if (!validRowValue(row)) {
      issues.push(t.profileIssues.value.replace("{field}", row.fieldKey.trim() || "?").replace("{type}", t.fieldTypes[row.type]));
    }
  }
  if ((effectiveFrom && !isCalendarDate(effectiveFrom)) || (effectiveTo && !isCalendarDate(effectiveTo))
    || (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom)) issues.push(t.profileIssues.dates);
  if (isAgreement && !STABLE_KEY_PATTERN.test(agreementKey.trim())) issues.push(t.profileIssues.agreementKey);
  if (isAgreement && parsedDeals.some((id) => !UUID_PATTERN.test(id))) issues.push(t.profileIssues.dealIds);
  if (evidenceKind !== "manual" && !evidenceId.trim()) issues.push(t.profileIssues.evidenceId);

  const updateRow = (rowId: number, patch: Partial<FieldRow>) =>
    setRows((current) => current.map((row) => row.rowId === rowId ? { ...row, ...patch } : row));

  async function send(command: CrmCommercialCommand) {
    setRefusal(null);
    const outcome = await writer.run(command);
    if (outcome.ok) {
      const record = outcome.result.record as { profile?: { version?: unknown } } | null;
      onAccepted(typeof record?.profile?.version === "number" ? record.profile.version : null);
      return;
    }
    if (!outcome.error.uncertain) setRefusal(describeCommercialRefusal(outcome.error, t));
  }

  function submit() {
    if (issues.length || locked) return;
    const fields: CrmCommercialFields = {};
    for (const row of rows) fields[row.fieldKey.trim()] = entryFromRow(row);
    const commandOwner: CrmCommercialProfileOwner = owner.kind === "agreement"
      ? { kind: "agreement", accountId: owner.accountId, agreementKey: agreementKey.trim(), dealIds: parsedDeals }
      : owner;
    void send({
      kind: "accept_commercial_profile",
      operationId: newCrmOperationId(),
      owner: commandOwner,
      expectedCurrentVersion: current?.version ?? 0,
      fields,
      effectiveFrom: effectiveFrom || null,
      effectiveTo: effectiveTo || null,
      evidence: {
        kind: evidenceKind,
        ...(evidenceKind !== "manual" && evidenceId.trim() ? { id: evidenceId.trim() } : {}),
        ...(evidenceKind !== "manual" && evidenceRevision.trim() ? { revision: evidenceRevision.trim() } : {}),
        ...(evidenceNote.trim() ? { note: evidenceNote.trim() } : {}),
      },
    });
  }

  const typeOptions = CRM_COMMERCIAL_FIELD_TYPES.map((type) => ({ value: type, label: t.fieldTypes[type] }));

  return (
    <div className="mt-2 space-y-3 rounded-lg bg-muted/30 p-3" data-commercial-profile-editor={owner.kind}>
      <div className="text-xs font-medium">
        {current ? t.profileEditorTitle.replace("{version}", String(current.version)) : t.profileEditorTitleFirst}
      </div>
      <fieldset disabled={locked} className="space-y-3">
        {isAgreement && (
          <div className="grid gap-2 sm:grid-cols-2">
            <CommercialInput label={t.agreementKey} value={agreementKey} disabled={Boolean(current)} maxLength={63}
              onChange={(value) => setAgreementKey(value.trim().toLowerCase())} />
            <div>
              <CommercialInput label={t.dealIds} value={dealIds} onChange={setDealIds} />
              <p className="mt-1 text-[11px] text-muted-foreground">{t.dealIdsHelp}</p>
            </div>
          </div>
        )}
        <ul className="divide-y divide-border" data-profile-field-rows>
          {rows.map((row) => (
            <li key={row.rowId} className="grid items-end gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto]" data-profile-field-row>
              <CommercialInput label={t.fieldKey} value={row.fieldKey} maxLength={63}
                onChange={(fieldKey) => updateRow(row.rowId, { fieldKey: fieldKey.trim().toLowerCase() })} />
              <CommercialSelect label={t.fieldType} value={row.type} options={typeOptions}
                onChange={(type) => updateRow(row.rowId, { type: type as CrmCommercialFieldType, value: "" })} />
              <div className="min-w-0">
                {row.notApplicable ? (
                  <div className="text-xs">
                    <span className="mb-1 block text-muted-foreground">{t.fieldValue}</span>
                    <span className="block py-2 italic text-muted-foreground">{t.doesNotApply}</span>
                  </div>
                ) : row.type === "boolean" ? (
                  <CommercialSelect label={t.fieldValue} value={row.value}
                    options={[{ value: "true", label: t.yes }, { value: "false", label: t.no }]}
                    onChange={(value) => updateRow(row.rowId, { value })} />
                ) : row.type === "text" ? (
                  <CommercialTextarea label={t.fieldValue} value={row.value} maxLength={5000} onChange={(value) => updateRow(row.rowId, { value })} />
                ) : row.type === "reference" ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <CommercialSelect label={t.referenceKind} value={row.referenceKind}
                      options={REFERENCE_KINDS.map((kind) => ({ value: kind, label: t.referenceKinds[kind] }))}
                      onChange={(kind) => updateRow(row.rowId, { referenceKind: kind as CrmCommercialReferenceKind })} />
                    <CommercialInput label={t.referenceId} value={row.value} onChange={(value) => updateRow(row.rowId, { value: value.trim() })} />
                  </div>
                ) : (
                  <CommercialInput label={t.fieldValue} type={row.type === "date" ? "date" : "text"} value={row.value}
                    maxLength={row.type === "string" ? 500 : 64}
                    onChange={(value) => updateRow(row.rowId, { value: row.type === "currency" ? value.trim().toUpperCase() : value })} />
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                <Button size="sm" variant={row.notApplicable ? "default" : "outline"} aria-pressed={row.notApplicable}
                  onClick={() => updateRow(row.rowId, { notApplicable: !row.notApplicable })}>
                  {t.doesNotApply}
                </Button>
                <Button size="icon-xs" variant="ghost" className="max-md:size-11" aria-label={t.removeField}
                  onClick={() => setRows((current) => current.filter((item) => item.rowId !== row.rowId))}>
                  <Trash2 aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {rows.length === 0 && <p className="text-[11px] text-muted-foreground">{t.noFields}</p>}
        <Button size="sm" variant="outline" disabled={rows.length >= 200}
          onClick={() => setRows((current) => [...current, { rowId: nextRowId(), fieldKey: "", type: "string", value: "", referenceKind: "company", notApplicable: false }])}>
          <Plus aria-hidden />{t.addField}
        </Button>
        <div className="grid gap-2 sm:grid-cols-2">
          <CommercialInput label={t.effectiveFrom} type="date" value={effectiveFrom} onChange={setEffectiveFrom} />
          <CommercialInput label={t.effectiveTo} type="date" value={effectiveTo} onChange={setEffectiveTo} />
        </div>
        <div>
          <div className="mb-1 text-xs font-medium">{t.evidence}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <CommercialSelect label={t.evidenceKind} value={evidenceKind}
              options={EVIDENCE_KINDS.map((kind) => ({ value: kind, label: t.evidenceKinds[kind] }))}
              onChange={(kind) => setEvidenceKind(kind as CrmCommercialEvidenceKind)} />
            {evidenceKind !== "manual" && (
              <>
                <CommercialInput label={t.evidenceId} value={evidenceId} maxLength={200} onChange={setEvidenceId} />
                <CommercialInput label={t.evidenceRevision} value={evidenceRevision} maxLength={200} onChange={setEvidenceRevision} />
              </>
            )}
            <CommercialInput label={t.evidenceNote} value={evidenceNote} maxLength={2000} onChange={setEvidenceNote} />
          </div>
        </div>
      </fieldset>
      <IssueList issues={[...new Set(issues)]} />
      <RefusalLine text={refusal} />
      <UncertainWrite writer={writer} onRetry={(command) => void send(command)} onDiscard={onCancel} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={writer.busy} onClick={onCancel}>{t.cancel}</Button>
        <Button size="sm" disabled={issues.length > 0 || locked} onClick={submit}>{writer.busy ? t.accepting : t.acceptTerms}</Button>
      </div>
    </div>
  );
}
