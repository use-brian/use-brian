"use client";

/**
 * CRM configuration -> References: the business-reference definition catalog,
 * a bounded format builder with a local masked example, partition and
 * assignment-event display, counters for owners/admins, and the reviewed
 * import of existing codes. Every write goes through the versioned reference
 * commands with a caller-held operation id.
 *
 * Spec: docs/architecture/features/crm-commercial-operations.md -> "Business references" -> "UI".
 * [COMP:app-web/crm-commercial-operations]
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Hash, Pencil, Plus, Search, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CRM_REFERENCE_PARTITION_DIMENSIONS,
  CrmReferenceRequestError,
  findCrmReferences,
  listCrmReferenceDefinitions,
  maskCrmReferenceFormat,
  newCrmOperationId,
  type CrmBusinessReference,
  type CrmReferenceAssignmentEvent,
  type CrmReferenceAssignmentMode,
  type CrmReferenceCategory,
  type CrmReferenceChangePolicy,
  type CrmReferenceDatePart,
  type CrmReferenceDefinition,
  type CrmReferenceDefinitionInput,
  type CrmReferenceDefinitionStatus,
  type CrmReferenceImportConflict,
  type CrmReferenceImportRow,
  type CrmReferencePartitionDimension,
  type CrmReferenceSegment,
  type CrmReferenceTargetKind,
} from "@/lib/api/crm-references";
import { useT } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import { describeReferenceRefusal, referenceInputClass, useReferenceCommand } from "./record-references";

type ReferenceCopy = Dictionary["crmPage"]["references"];

const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_KINDS: readonly CrmReferenceTargetKind[] = ["company", "deal", "account", "invoice"];
const SEGMENT_KINDS: readonly CrmReferenceSegment["kind"][] = ["literal", "date", "category", "parent", "counter"];
const DATE_PARTS: readonly CrmReferenceDatePart[] = ["yyyy", "yy", "mm", "dd"];
const MAX_SEGMENTS = 24;
const MAX_IMPORT_ROWS = 1000;

const stableKey = (label: string) => label.trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/g, "").slice(0, 63);

const emptyDraft = (): CrmReferenceDefinitionInput => ({
  definitionKey: "",
  label: "",
  targetKinds: ["company"],
  assignmentMode: "native",
  namespaceKey: "",
  format: [{ kind: "literal", text: "C-" }, { kind: "counter", width: 5 }],
  partitionDimensions: [],
  categories: [],
  timezone: "UTC",
  assignmentEvent: "explicit",
  changePolicy: "immutable",
  counterStart: 1,
  status: "active",
});

const draftFrom = (definition: CrmReferenceDefinition): CrmReferenceDefinitionInput => ({
  definitionKey: definition.definitionKey,
  label: definition.label,
  targetKinds: [...definition.targetKinds],
  assignmentMode: definition.assignmentMode,
  namespaceKey: definition.namespaceKey,
  format: definition.format ? definition.format.map((segment) => ({ ...segment })) : null,
  partitionDimensions: [...definition.partitionDimensions],
  categories: definition.categories.map((category) => ({ ...category })),
  timezone: definition.timezone,
  assignmentEvent: definition.assignmentEvent,
  changePolicy: definition.changePolicy,
  counterStart: definition.counterStart,
  status: definition.status,
});

/** The local, non-reserving shape of a format. */
function maskedReferenceExample(segments: readonly CrmReferenceSegment[], t: Pick<ReferenceCopy, "categoryToken">): string {
  return maskCrmReferenceFormat(segments, { parent: (key) => `[${key}]`, category: t.categoryToken });
}

/** Cross-field rules the server also enforces, phrased for the editor. */
function draftIssues(draft: CrmReferenceDefinitionInput, t: ReferenceCopy): string[] {
  const issues: string[] = [];
  if (!KEY_PATTERN.test(draft.definitionKey) || !KEY_PATTERN.test(draft.namespaceKey)) issues.push(t.keyInvalid);
  if (draft.targetKinds.length === 0) issues.push(t.targetKindsNeeded);
  const format = draft.format ?? [];
  const counters = format.filter((segment) => segment.kind === "counter").length;
  if (draft.assignmentMode === "native" && counters !== 1) issues.push(t.nativeNeedsCounter);
  if (draft.assignmentMode !== "native" && counters > 0) issues.push(t.onlyNativeCounter);
  if (draft.assignmentMode !== "native" && draft.partitionDimensions.length > 0) issues.push(t.onlyNativePartitions);
  const usesParent = format.some((segment) => segment.kind === "parent") || draft.partitionDimensions.includes("parent_target");
  if (usesParent && draft.targetKinds.includes("company")) issues.push(t.parentNeedsCompany);
  if (format.some((segment) => segment.kind === "parent" && !KEY_PATTERN.test(segment.definitionKey))) issues.push(t.pickParent);
  const invoices = draft.targetKinds.includes("invoice");
  if ((invoices && (draft.targetKinds.length !== 1 || draft.assignmentEvent !== "issue"))
    || (!invoices && draft.assignmentEvent === "issue")) issues.push(t.invoiceNeedsIssue);
  const usesCategory = format.some((segment) => segment.kind === "category") || draft.partitionDimensions.includes("service_category");
  if (usesCategory && draft.categories.length === 0) issues.push(t.categoriesNeeded);
  if (draft.categories.some((category) => !KEY_PATTERN.test(category.key) || !category.code.trim() || !category.label.trim())) issues.push(t.keyInvalid);
  return [...new Set(issues)];
}

export function CrmReferenceSettings({ workspaceId, canConfigure, onOpenRecord }: {
  workspaceId: string;
  canConfigure: boolean;
  /** Opens a company or deal record the way the CRM surface does. */
  onOpenRecord?: (kind: "company" | "deal", id: string) => void;
}) {
  const t = useT().crmPage.references;
  const [definitions, setDefinitions] = useState<CrmReferenceDefinition[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<{ definition: CrmReferenceDefinition | null } | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void listCrmReferenceDefinitions(workspaceId, true)
      .then((rows) => { if (!cancelled) setDefinitions(rows); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [workspaceId, attempt]);

  const reload = () => setAttempt((value) => value + 1);

  return (
    <section className="border-t border-border pt-5" data-crm-reference-settings>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Hash className="size-3.5" aria-hidden />{t.title}</h3>
          <p className="text-xs text-muted-foreground">{t.description}</p>
        </div>
        {canConfigure && !editing && (
          <Button size="sm" variant="outline" onClick={() => { setSaved(false); setEditing({ definition: null }); }}><Plus aria-hidden />{t.newDefinition}</Button>
        )}
      </div>
      <ReferenceLookup workspaceId={workspaceId} definitions={definitions ?? []} onOpenRecord={onOpenRecord} />
      {!canConfigure && <p className="mb-2 text-xs text-muted-foreground">{t.readOnly}</p>}
      {saved && <p role="status" className="mb-2 text-xs text-emerald-700 dark:text-emerald-300">{t.saved}</p>}
      {editing && canConfigure && (
        <DefinitionEditor
          workspaceId={workspaceId}
          definition={editing.definition}
          companyDefinitions={(definitions ?? []).filter((definition) =>
            definition.targetKinds.includes("company") && definition.status !== "archived"
            && definition.definitionKey !== editing.definition?.definitionKey)}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); setSaved(true); reload(); }}
          onReload={reload}
        />
      )}
      {failed ? (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>{t.loadFailed}</span>
          <Button size="sm" variant="ghost" onClick={reload}>{t.retry}</Button>
        </div>
      ) : !definitions ? (
        <div className="text-xs text-muted-foreground">{t.loading}</div>
      ) : definitions.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t.empty}</div>
      ) : (
        <ul className="space-y-2">
          {definitions.map((definition) => (
            <li key={definition.id} data-reference-definition={definition.definitionKey} className={definition.status === "archived" ? "rounded-xl border border-dashed border-border p-3 opacity-75" : "rounded-xl border border-border p-3"}>
              <DefinitionSummary definition={definition} />
              {canConfigure && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={() => { setSaved(false); setEditing({ definition }); }}><Pencil aria-hidden />{t.edit}</Button>
                  {definition.status !== "archived" && definition.targetKinds.some((kind) => kind === "company" || kind === "deal") && (
                    <Button size="sm" variant="ghost" onClick={() => setImporting((value) => value === definition.id ? null : definition.id)}><Upload aria-hidden />{t.importTitle}</Button>
                  )}
                </div>
              )}
              {canConfigure && importing === definition.id && (
                <ImportPanel workspaceId={workspaceId} definition={definition} onImported={reload} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReferenceLookup({ workspaceId, definitions, onOpenRecord }: {
  workspaceId: string;
  definitions: CrmReferenceDefinition[];
  onOpenRecord?: (kind: "company" | "deal", id: string) => void;
}) {
  const t = useT().crmPage.references;
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState<"exact" | "prefix">("exact");
  const [result, setResult] = useState<{ query: string; references: CrmBusinessReference[]; more: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const labels = new Map(definitions.map((definition) => [definition.id, definition.label]));

  async function search() {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const body = await findCrmReferences(workspaceId, q, match);
      setResult({ query: q, references: body.references, more: Boolean(body.nextCursor) });
    } catch {
      setResult(null);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4" data-reference-lookup>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium"><Search className="size-3.5" aria-hidden />{t.findTitle}</div>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <input
          value={query}
          maxLength={128}
          aria-label={t.findLabel}
          placeholder={t.findPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
          className={`${referenceInputClass} flex-1 sm:w-auto`}
        />
        <div className="flex gap-1" role="group" aria-label={t.findLabel}>
          {(["exact", "prefix"] as const).map((value) => (
            <Button key={value} type="button" size="sm" variant={match === value ? "default" : "outline"} aria-pressed={match === value} onClick={() => setMatch(value)}>
              {t.matchLabels[value]}
            </Button>
          ))}
        </div>
        <Button type="submit" size="sm" disabled={busy || !query.trim()}>{busy ? t.finding : t.find}</Button>
      </form>
      {failed && (
        <div role="alert" className="mt-2 flex items-center justify-between gap-2 text-xs text-destructive">
          <span>{t.findFailed}</span>
          <Button size="sm" variant="ghost" onClick={() => void search()}>{t.retry}</Button>
        </div>
      )}
      {result && (result.references.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{t.findEmpty.replace("{query}", result.query)}</p>
      ) : (
        <ul className="mt-2 divide-y divide-border text-xs" data-reference-lookup-results>
          {result.references.map((reference) => {
            const current = reference.status === "active";
            const name = reference.targetName ?? t.unnamedRecord;
            return (
              <li key={reference.id} data-reference-status={reference.status} className={current ? "flex flex-wrap items-center gap-x-2 gap-y-1 py-2" : "flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-muted-foreground"}>
                <span className={current ? "font-mono text-sm font-medium" : "font-mono line-through decoration-muted-foreground/50"}>{reference.value}</span>
                {!current && <span className="text-[11px]">{t.referenceStatus[reference.status]}</span>}
                <span className="text-[11px] text-muted-foreground">{labels.get(reference.definitionId) ?? reference.definitionKey}</span>
                <span className="ml-auto flex items-center gap-1">
                  <span className="text-[11px] text-muted-foreground">{t.recordKindLabels[reference.targetKind]}</span>
                  {onOpenRecord && (reference.targetKind === "company" || reference.targetKind === "deal") ? (
                    <Button size="sm" variant="ghost" aria-label={t.openRecord.replace("{name}", name)} onClick={() => onOpenRecord(reference.targetKind as "company" | "deal", reference.targetId)}>{name}</Button>
                  ) : (
                    <span className="font-medium">{name}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ))}
      {result?.more && <p className="mt-1 text-[11px] text-muted-foreground">{t.findMore}</p>}
    </div>
  );
}

function DefinitionSummary({ definition }: { definition: CrmReferenceDefinition }) {
  const t = useT().crmPage.references;
  const example = definition.format ? maskedReferenceExample(definition.format, t) : null;
  return (
    <div className="min-w-0 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{definition.label}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{definition.definitionKey}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">{t.statusLabels[definition.status]}</span>
      </div>
      {example && <div className="mt-1 font-mono text-sm" data-reference-definition-example>{example}</div>}
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-2">
        <div><dt className="inline">{t.targetKinds}: </dt><dd className="inline text-foreground/80">{definition.targetKinds.map((kind) => t.targetKindLabels[kind]).join(", ")}</dd></div>
        <div><dt className="inline">{t.assignmentMode}: </dt><dd className="inline text-foreground/80">{t.assignmentModeLabels[definition.assignmentMode]}</dd></div>
        <div><dt className="inline">{t.assignmentEvent}: </dt><dd className="inline text-foreground/80">{t.assignmentEventLabels[definition.assignmentEvent]}</dd></div>
        <div><dt className="inline">{t.partitions}: </dt><dd className="inline text-foreground/80">{definition.partitionDimensions.length ? definition.partitionDimensions.map((dimension) => t.partitionLabels[dimension]).join(", ") : t.noPartitions}</dd></div>
        <div><dt className="inline">{t.changePolicy}: </dt><dd className="inline text-foreground/80">{t.changePolicyLabels[definition.changePolicy]}</dd></div>
        <div><dt className="inline">{t.namespaceKey}: </dt><dd className="inline font-mono text-foreground/80">{definition.namespaceKey}</dd></div>
      </dl>
      {definition.partitions && definition.assignmentMode === "native" && (
        <div className="mt-2" data-reference-counters>
          <div className="text-[11px] font-medium text-muted-foreground">{t.counters}</div>
          {definition.partitions.length === 0 ? (
            <div className="text-[11px] text-muted-foreground">{t.noCounters}</div>
          ) : (
            <ul className="text-[11px]">
              {definition.partitions.map((partition) => (
                <li key={partition.partitionKey} className="font-mono">
                  {t.counterRow
                    .replace("{partition}", partition.partitionKey)
                    .replace("{next}", String(partition.nextValue))
                    .replace("{count}", String(partition.allocatedCount))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function DefinitionEditor({
  workspaceId,
  definition,
  companyDefinitions,
  onCancel,
  onSaved,
  onReload,
}: {
  workspaceId: string;
  definition: CrmReferenceDefinition | null;
  companyDefinitions: CrmReferenceDefinition[];
  onCancel: () => void;
  onSaved: () => void;
  onReload: () => void;
}) {
  const t = useT().crmPage.references;
  const [draft, setDraft] = useState<CrmReferenceDefinitionInput>(() => definition ? draftFrom(definition) : emptyDraft());
  const [keyTouched, setKeyTouched] = useState(Boolean(definition));
  const [frozen, setFrozen] = useState<string[] | null>(null);
  const [refusal, setRefusal] = useState<{ text: string; issues: string[] } | null>(null);
  const writer = useReferenceCommand(workspaceId);
  const issues = useMemo(() => draftIssues(draft, t), [draft, t]);
  const segments = draft.format ?? [];
  const locked = writer.busy || writer.uncertain !== null;

  const update = (patch: Partial<CrmReferenceDefinitionInput>) => setDraft((current) => ({ ...current, ...patch }));
  const setSegments = (next: CrmReferenceSegment[]) => update({ format: next.length ? next : null });

  function usePreset(kind: "client" | "invoice") {
    setKeyTouched(true);
    setDraft(kind === "client" ? {
      ...emptyDraft(), definitionKey: "client_code", namespaceKey: "client_code", label: t.clientCodePreset,
      assignmentMode: "manual", format: null,
    } : {
      ...emptyDraft(), definitionKey: "invoice_number", namespaceKey: "invoice_number", label: t.invoicePreset,
      targetKinds: ["invoice"], assignmentEvent: "issue", partitionDimensions: ["business_year"],
      format: [{ kind: "literal", text: "INV-" }, { kind: "parent", definitionKey: (companyDefinitions.find((item) => item.definitionKey === "client_code") ?? companyDefinitions[0])?.definitionKey ?? "" },
        { kind: "literal", text: "-" }, { kind: "date", part: "yyyy" }, { kind: "literal", text: "-" }, { kind: "counter", width: 3 }],
    });
  }

  function setLabel(label: string) {
    if (keyTouched) { update({ label }); return; }
    const key = stableKey(label);
    update({ label, definitionKey: key, namespaceKey: key });
  }

  function addSegment(kind: CrmReferenceSegment["kind"]) {
    if (segments.length >= MAX_SEGMENTS) return;
    const segment: CrmReferenceSegment = kind === "literal" ? { kind, text: "-" }
      : kind === "date" ? { kind, part: "yyyy" }
      : kind === "category" ? { kind }
      : kind === "parent" ? { kind, definitionKey: companyDefinitions[0]?.definitionKey ?? "" }
      : { kind, width: 5 };
    setSegments([...segments, segment]);
  }

  function moveSegment(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= segments.length) return;
    const next = [...segments];
    [next[index], next[target]] = [next[target], next[index]];
    setSegments(next);
  }

  function replaceSegment(index: number, segment: CrmReferenceSegment) {
    setSegments(segments.map((item, position) => position === index ? segment : item));
  }

  function setCategory(index: number, patch: Partial<CrmReferenceCategory>) {
    update({ categories: draft.categories.map((item, position) => position === index ? { ...item, ...patch } : item) });
  }

  async function send(command: Parameters<typeof writer.run>[0]) {
    setFrozen(null);
    setRefusal(null);
    const outcome = await writer.run(command);
    if (outcome.ok) { onSaved(); return; }
    if (outcome.error.uncertain) return;
    applyRefusal(outcome.error);
  }

  function applyRefusal(error: CrmReferenceRequestError) {
    const reason = error.reason;
    if (reason === "definition_frozen") {
      setFrozen(Array.isArray(error.details.fields) ? error.details.fields.filter((field): field is string => typeof field === "string") : []);
      return;
    }
    const serverIssues = Array.isArray(error.details.issues)
      ? error.details.issues.map((issue) => (issue as { message?: unknown }).message).filter((message): message is string => typeof message === "string")
      : [];
    const text = reason === "stale_version" ? t.staleDefinition
      : reason === "definition_key_taken" ? t.keyTaken
      : reason === "namespace_taken" ? t.namespaceTaken
      : error.code === "invalid_input" || error.code === "catalog_key_invalid" ? t.invalidDefinition
      : error.code === "not_authorized" || error.status === 403 ? t.notAuthorized
      : t.saveFailed;
    setRefusal({ text, issues: serverIssues.length ? serverIssues : error.code === "catalog_key_invalid" && error.message ? [error.message] : [] });
  }

  function save() {
    if (issues.length || locked) return;
    const cleaned: CrmReferenceDefinitionInput = {
      ...draft,
      label: draft.label.trim(),
      timezone: draft.timezone.trim() || "UTC",
      categories: draft.categories.map((category) => ({ key: category.key.trim(), code: category.code.trim(), label: category.label.trim() })),
    };
    void send({
      kind: "save_reference_definition",
      operationId: newCrmOperationId(),
      ...(definition ? { definitionId: definition.id, expectedVersion: definition.version } : {}),
      definition: cleaned,
    });
  }

  const example = segments.length ? maskedReferenceExample(segments, t) : null;
  const native = draft.assignmentMode === "native";

  return (
    <div className="mb-3 rounded-xl border border-border bg-muted/20 p-3" data-reference-definition-editor>
      <div className="mb-3 text-sm font-medium">{definition ? t.editTitle.replace("{name}", definition.label) : t.newTitle}</div>
      <fieldset disabled={locked} className="space-y-4">
        {!definition && (
          <div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => usePreset("client")}>{t.clientCodePreset}</Button>
              <Button size="sm" variant="outline" onClick={() => usePreset("invoice")}>{t.invoicePreset}</Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t.invoicePresetHelp}</p>
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-3">
          <EditorInput label={t.label} value={draft.label} onChange={setLabel} />
          <EditorInput label={t.definitionKey} value={draft.definitionKey} disabled={Boolean(definition)} onChange={(value) => { setKeyTouched(true); update({ definitionKey: value.trim().toLowerCase() }); }} />
          <EditorInput label={t.namespaceKey} value={draft.namespaceKey} onChange={(value) => { setKeyTouched(true); update({ namespaceKey: value.trim().toLowerCase() }); }} />
        </div>
        <p className="-mt-2 text-[11px] text-muted-foreground">{t.namespaceHelp}</p>

        <div>
          <div className="mb-1 text-xs text-muted-foreground">{t.targetKinds}</div>
          <div className="flex flex-wrap gap-2">
            {TARGET_KINDS.map((kind) => (
              <Button key={kind} size="sm" variant={draft.targetKinds.includes(kind) ? "default" : "outline"} aria-pressed={draft.targetKinds.includes(kind)}
                onClick={() => update({ targetKinds: draft.targetKinds.includes(kind) ? draft.targetKinds.filter((item) => item !== kind) : [...draft.targetKinds, kind] })}>
                {t.targetKindLabels[kind]}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <EditorSelect label={t.assignmentMode} value={draft.assignmentMode} options={(["native", "manual", "external"] as const).map((value) => ({ value, label: t.assignmentModeLabels[value] }))}
            onChange={(value) => update({ assignmentMode: value as CrmReferenceAssignmentMode, ...(value === "native" ? {} : { partitionDimensions: [] }) })} />
          <EditorSelect label={t.assignmentEvent} value={draft.assignmentEvent} options={(["explicit", "approval", "issue"] as const).map((value) => ({ value, label: t.assignmentEventLabels[value] }))}
            onChange={(value) => update({ assignmentEvent: value as CrmReferenceAssignmentEvent })} />
          <EditorSelect label={t.changePolicy} value={draft.changePolicy} options={(["immutable", "correctable"] as const).map((value) => ({ value, label: t.changePolicyLabels[value] }))}
            onChange={(value) => update({ changePolicy: value as CrmReferenceChangePolicy })} />
          <EditorSelect label={t.status} value={draft.status} options={(["draft", "active", "archived"] as const).map((value) => ({ value, label: t.statusLabels[value] }))}
            onChange={(value) => update({ status: value as CrmReferenceDefinitionStatus })} />
        </div>

        <div>
          <div className="text-xs font-medium">{t.format}</div>
          <p className="mb-2 text-[11px] text-muted-foreground">{t.formatHelp}</p>
          {segments.length === 0 && <p className="text-[11px] text-muted-foreground">{t.noFormat}</p>}
          <ol className="divide-y divide-border">
            {segments.map((segment, index) => (
              <li key={index} className="flex flex-wrap items-end gap-2 py-2" data-reference-segment={segment.kind}>
                <span className="w-full text-[11px] font-medium text-muted-foreground sm:w-28">{t.segmentKinds[segment.kind]}</span>
                <div className="min-w-0 flex-1">
                  {segment.kind === "literal" && (
                    <EditorInput label={t.literalText} value={segment.text} maxLength={32} onChange={(text) => replaceSegment(index, { kind: "literal", text })} />
                  )}
                  {segment.kind === "counter" && (
                    <EditorInput label={t.counterWidth} type="number" min={1} max={12} value={String(segment.width)}
                      onChange={(value) => replaceSegment(index, { kind: "counter", width: Math.min(12, Math.max(1, Math.trunc(Number(value)) || 1)) })} />
                  )}
                  {segment.kind === "date" && (
                    <EditorSelect label={t.datePart} value={segment.part} options={DATE_PARTS.map((part) => ({ value: part, label: t.dateParts[part] }))}
                      onChange={(part) => replaceSegment(index, { kind: "date", part: part as CrmReferenceDatePart })} />
                  )}
                  {segment.kind === "parent" && (
                    <EditorSelect label={t.parentDefinition} value={segment.definitionKey} placeholder={t.pickParent}
                      options={companyDefinitions.map((item) => ({ value: item.definitionKey, label: item.label }))}
                      onChange={(definitionKey) => replaceSegment(index, { kind: "parent", definitionKey })} />
                  )}
                </div>
                <div className="flex gap-1">
                  <Button size="icon-xs" variant="ghost" className="max-md:size-11" aria-label={t.moveUp} disabled={index === 0} onClick={() => moveSegment(index, -1)}><ArrowUp aria-hidden /></Button>
                  <Button size="icon-xs" variant="ghost" className="max-md:size-11" aria-label={t.moveDown} disabled={index === segments.length - 1} onClick={() => moveSegment(index, 1)}><ArrowDown aria-hidden /></Button>
                  <Button size="icon-xs" variant="ghost" className="max-md:size-11" aria-label={t.removeSegment} onClick={() => setSegments(segments.filter((_, position) => position !== index))}><Trash2 aria-hidden /></Button>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-2 flex flex-wrap gap-1">
            {SEGMENT_KINDS.map((kind) => (
              <Button key={kind} size="sm" variant="outline" disabled={segments.length >= MAX_SEGMENTS} onClick={() => addSegment(kind)}>
                <Plus aria-hidden />{t.segmentKinds[kind]}
              </Button>
            ))}
          </div>
          {example && (
            <div className="mt-2 rounded-md bg-background px-3 py-2">
              <div className="text-[11px] text-muted-foreground">{t.maskedExample}</div>
              <div className="font-mono text-sm" data-reference-masked-example>{example}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">{t.maskedExampleHelp}</div>
            </div>
          )}
        </div>

        {native && (
          <div>
            <div className="mb-1 text-xs text-muted-foreground">{t.partitions}</div>
            <div className="flex flex-wrap gap-2">
              {CRM_REFERENCE_PARTITION_DIMENSIONS.map((dimension) => (
                <Button key={dimension} size="sm" variant={draft.partitionDimensions.includes(dimension) ? "default" : "outline"} aria-pressed={draft.partitionDimensions.includes(dimension)}
                  onClick={() => update({ partitionDimensions: draft.partitionDimensions.includes(dimension)
                    ? draft.partitionDimensions.filter((item) => item !== dimension)
                    : CRM_REFERENCE_PARTITION_DIMENSIONS.filter((item) => item === dimension || draft.partitionDimensions.includes(item)) as CrmReferencePartitionDimension[] })}>
                  {t.partitionLabels[dimension]}
                </Button>
              ))}
            </div>
            {draft.partitionDimensions.length === 0 && <p className="mt-1 text-[11px] text-muted-foreground">{t.noPartitions}</p>}
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <EditorInput label={t.timezone} value={draft.timezone} onChange={(timezone) => update({ timezone })} />
            <p className="mt-1 text-[11px] text-muted-foreground">{t.timezoneHelp}</p>
          </div>
          {native && (
            <EditorInput label={t.counterStart} type="number" min={0} value={String(draft.counterStart)}
              onChange={(value) => update({ counterStart: Math.max(0, Math.trunc(Number(value)) || 0) })} />
          )}
        </div>

        <div>
          <div className="mb-1 text-xs font-medium">{t.categories}</div>
          {draft.categories.length === 0 && <p className="text-[11px] text-muted-foreground">{t.noCategories}</p>}
          <ul className="space-y-2">
            {draft.categories.map((category, index) => (
              <li key={index} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto]">
                <EditorInput label={t.categoryKey} value={category.key} onChange={(key) => setCategory(index, { key: key.trim().toLowerCase() })} />
                <EditorInput label={t.categoryCode} value={category.code} maxLength={32} onChange={(code) => setCategory(index, { code })} />
                <EditorInput label={t.categoryLabel} value={category.label} onChange={(label) => setCategory(index, { label })} />
                <Button size="icon-xs" variant="ghost" className="max-md:size-11" aria-label={t.removeCategory} onClick={() => update({ categories: draft.categories.filter((_, position) => position !== index) })}><Trash2 aria-hidden /></Button>
              </li>
            ))}
          </ul>
          <Button className="mt-2" size="sm" variant="outline" disabled={draft.categories.length >= 200} onClick={() => update({ categories: [...draft.categories, { key: "", code: "", label: "" }] })}><Plus aria-hidden />{t.addCategory}</Button>
        </div>
      </fieldset>

      {issues.length > 0 && (
        <ul className="mt-3 list-disc space-y-0.5 pl-5 text-[11px] text-amber-700 dark:text-amber-300" data-reference-draft-issues>
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      )}
      {frozen && (
        <div role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" data-reference-frozen>
          <div className="font-semibold">{t.frozenTitle}</div>
          <p className="mt-1">{t.frozenDescription}</p>
          <ul className="mt-1 list-disc pl-5">
            {frozen.map((field) => <li key={field}>{field in t.frozenFields ? t.frozenFields[field as keyof ReferenceCopy["frozenFields"]] : field}</li>)}
          </ul>
        </div>
      )}
      {refusal && (
        <div role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <p>{refusal.text}</p>
          {refusal.issues.length > 0 && <ul className="mt-1 list-disc pl-5">{refusal.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
        </div>
      )}
      {writer.uncertain && (
        <div role="alert" className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <p>{t.uncertainWrite}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={writer.busy} onClick={() => { if (writer.uncertain) void send(writer.uncertain); }}>{t.retryWrite}</Button>
            <Button size="sm" variant="ghost" disabled={writer.busy} onClick={() => { writer.discard(); onReload(); onCancel(); }}>{t.discardAndReload}</Button>
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={writer.busy} onClick={onCancel}>{t.cancel}</Button>
        <Button size="sm" disabled={issues.length > 0 || locked || !draft.label.trim()} onClick={save}>{writer.busy ? t.saving : t.save}</Button>
      </div>
    </div>
  );
}

type ParsedImport = { rows: CrmReferenceImportRow[]; lines: number[]; errors: string[] };

/** Parse `kind,recordId,value,status` lines. Values cannot contain commas. */
function parseReferenceImportRows(text: string, t: ReferenceCopy): ParsedImport {
  const parsed: ParsedImport = { rows: [], lines: [], errors: [] };
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const problem = (key: keyof ReferenceCopy["importProblems"]) =>
      parsed.errors.push(t.importParseError.replace("{line}", String(index + 1)).replace("{problem}", t.importProblems[key]));
    const cells = line.split(",").map((cell) => cell.trim());
    if (cells.length < 3 || cells.length > 4) return problem("columns");
    const [kind, id, value, status = "active"] = cells;
    if (kind !== "company" && kind !== "deal") return problem("kind");
    if (!UUID_PATTERN.test(id)) return problem("id");
    if (!value || value.length > 128) return problem("value");
    const normalizedStatus = (status || "active").toLowerCase();
    if (normalizedStatus !== "active" && normalizedStatus !== "retired") return problem("status");
    parsed.rows.push({ target: { kind, id }, value, status: normalizedStatus });
    parsed.lines.push(index + 1);
  });
  return parsed;
}

function ImportPanel({ workspaceId, definition, onImported }: {
  workspaceId: string;
  definition: CrmReferenceDefinition;
  onImported: () => void;
}) {
  const t = useT().crmPage.references;
  const [text, setText] = useState("");
  const [counters, setCounters] = useState<Array<{ partitionKey: string; nextValue: string }>>([]);
  const [conflicts, setConflicts] = useState<{ list: CrmReferenceImportConflict[]; count: number } | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const writer = useReferenceCommand(workspaceId);
  const parsed = useMemo(() => parseReferenceImportRows(text, t), [text, t]);
  const counterErrors = counters.flatMap((counter, index) => {
    const problems: string[] = [];
    const say = (key: keyof ReferenceCopy["importProblems"]) =>
      problems.push(t.importCounterProblem.replace("{index}", String(index + 1)).replace("{problem}", t.importProblems[key]));
    if (!counter.partitionKey.trim()) say("partitionKey");
    if (!/^\d+$/.test(counter.nextValue.trim())) say("nextValue");
    return problems;
  });
  const errors = [
    ...parsed.errors,
    ...counterErrors,
    ...(parsed.rows.length > MAX_IMPORT_ROWS ? [t.importTooMany] : []),
  ];
  const empty = parsed.rows.length === 0 && counters.length === 0;
  const locked = writer.busy || writer.uncertain !== null;

  async function send(command: Parameters<typeof writer.run>[0]) {
    setConflicts(null);
    setMessage(null);
    const outcome = await writer.run(command);
    if (outcome.ok) {
      if (command.kind === "import_business_references") {
        setMessage({ tone: "success", text: t.importDone
          .replace("{rows}", String(command.rows.length))
          .replace("{counters}", String(command.partitionCounters.length)) });
      }
      setText("");
      setCounters([]);
      onImported();
      return;
    }
    if (outcome.error.uncertain) return;
    if (outcome.error.reason === "import_conflicts") {
      const list = Array.isArray(outcome.error.details.conflicts)
        ? outcome.error.details.conflicts as CrmReferenceImportConflict[]
        : [];
      const count = typeof outcome.error.details.conflictCount === "number" ? outcome.error.details.conflictCount : list.length;
      setConflicts({ list, count });
      return;
    }
    setMessage({ tone: "error", text: outcome.error.code === "invalid_input" ? t.importFailed : describeReferenceRefusal(outcome.error, t) });
  }

  async function submit() {
    if (errors.length || empty || locked) return;
    const partitionCounters = counters.map((counter) => ({ partitionKey: counter.partitionKey.trim(), nextValue: Number(counter.nextValue.trim()) }));
    const confirmed = await confirmDialog({
      title: t.importConfirmTitle.replace("{name}", definition.label),
      description: t.importConfirmDescription
        .replace("{rows}", String(parsed.rows.length))
        .replace("{counters}", String(partitionCounters.length)),
      confirmLabel: t.importSubmit,
      cancelLabel: t.cancel,
    });
    if (!confirmed) return;
    await send({
      kind: "import_business_references",
      operationId: newCrmOperationId(),
      definitionKey: definition.definitionKey,
      rows: parsed.rows,
      partitionCounters,
    });
  }

  /** The submitted row a conflict points at, for display. */
  const rowFor = (index: number) => parsed.rows[index];

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border bg-muted/20 p-3" data-reference-import>
      <div>
        <div className="text-xs font-medium">{t.importTitle}</div>
        <p className="text-[11px] text-muted-foreground">{t.importHelp}</p>
      </div>
      <fieldset disabled={locked} className="space-y-3">
        <label className="block text-xs">
          <span className="mb-1 block text-muted-foreground">{t.importRows}</span>
          <textarea
            value={text}
            rows={5}
            spellCheck={false}
            onChange={(event) => { setText(event.target.value); setConflicts(null); }}
            placeholder="company,00000000-0000-4000-8000-000000000001,C-00042,active"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-[16px] outline-none md:text-xs"
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">{t.importRowsHelp}</span>
        </label>
        {definition.assignmentMode === "native" && (
          <div>
            <div className="text-xs text-muted-foreground">{t.importCounters}</div>
            <p className="mb-1 text-[11px] text-muted-foreground">{t.importCountersHelp}</p>
            <ul className="space-y-2">
              {counters.map((counter, index) => (
                <li key={index} className="grid items-end gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
                  <EditorInput label={t.partitionKey} value={counter.partitionKey} onChange={(partitionKey) => setCounters((rows) => rows.map((row, position) => position === index ? { ...row, partitionKey } : row))} />
                  <EditorInput label={t.nextValue} type="number" min={0} value={counter.nextValue} onChange={(nextValue) => setCounters((rows) => rows.map((row, position) => position === index ? { ...row, nextValue } : row))} />
                  <Button size="icon-xs" variant="ghost" className="max-md:size-11" aria-label={t.removeCounter} onClick={() => setCounters((rows) => rows.filter((_, position) => position !== index))}><Trash2 aria-hidden /></Button>
                </li>
              ))}
            </ul>
            <Button className="mt-2" size="sm" variant="outline" onClick={() => setCounters((rows) => [...rows, { partitionKey: definition.partitionDimensions.length ? "" : "all", nextValue: "" }])}><Plus aria-hidden />{t.addCounter}</Button>
          </div>
        )}
      </fieldset>

      {errors.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-amber-700 dark:text-amber-300">{errors.map((error) => <li key={error}>{error}</li>)}</ul>
      )}
      {parsed.rows.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium">{t.importPreview}</div>
          <div className="max-h-56 overflow-auto rounded-md bg-background">
            <table className="w-full text-left text-[11px]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 font-medium">{t.importColumns.line}</th>
                  <th className="px-2 py-1 font-medium">{t.importColumns.kind}</th>
                  <th className="hidden px-2 py-1 font-medium sm:table-cell">{t.importColumns.target}</th>
                  <th className="px-2 py-1 font-medium">{t.importColumns.value}</th>
                  <th className="px-2 py-1 font-medium">{t.importColumns.status}</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.slice(0, 200).map((row, index) => (
                  <tr key={index} className="border-t border-border/60">
                    <td className="px-2 py-1">{parsed.lines[index]}</td>
                    <td className="px-2 py-1">{t.targetKindLabels[row.target.kind]}</td>
                    <td className="hidden px-2 py-1 font-mono sm:table-cell">{row.target.id}</td>
                    <td className="px-2 py-1 font-mono">{row.value}</td>
                    <td className="px-2 py-1">{t.importStatusLabels[row.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {conflicts && (
        <div role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" data-reference-import-conflicts>
          <div className="font-semibold">{t.importConflictsTitle}</div>
          <p className="mt-1">{t.importConflictsDescription.replace("{count}", String(conflicts.count))}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {conflicts.list.map((conflict, index) => {
              const row = conflict.index >= 0 ? rowFor(conflict.index) : undefined;
              const where = conflict.index >= 0
                ? t.importConflictRow.replace("{row}", String(parsed.lines[conflict.index] ?? conflict.index + 1))
                : t.importConflictCounter.replace("{partition}", conflict.partitionKey ?? "");
              const reason = conflict.reason in t.importConflictReasons
                ? t.importConflictReasons[conflict.reason as keyof ReferenceCopy["importConflictReasons"]]
                : conflict.reason;
              const value = conflict.value ?? row?.value;
              return <li key={`${conflict.index}-${conflict.reason}-${index}`}>{where}{value ? ` (${value})` : ""}: {reason}</li>;
            })}
          </ul>
          {conflicts.count > conflicts.list.length && (
            <p className="mt-1">{t.importConflictsShowing.replace("{shown}", String(conflicts.list.length)).replace("{count}", String(conflicts.count))}</p>
          )}
        </div>
      )}
      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-xs text-destructive" : "text-xs text-emerald-700 dark:text-emerald-300"}>{message.text}</p>
      )}
      {writer.uncertain && (
        <div role="alert" className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <p>{t.uncertainWrite}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={writer.busy} onClick={() => { if (writer.uncertain) void send(writer.uncertain); }}>{t.retryWrite}</Button>
            <Button size="sm" variant="ghost" disabled={writer.busy} onClick={() => { writer.discard(); onImported(); }}>{t.discardAndReload}</Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {empty && <span className="mr-auto text-[11px] text-muted-foreground">{t.importEmpty}</span>}
        <Button size="sm" disabled={errors.length > 0 || empty || locked} onClick={() => void submit()}>{writer.busy ? t.importing : t.importSubmit}</Button>
      </div>
    </div>
  );
}

function EditorInput({ label, value, onChange, type = "text", disabled, maxLength, min, max }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number";
  disabled?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="block min-w-0 text-xs">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <input type={type} value={value} disabled={disabled} maxLength={maxLength} min={min} max={max}
        onChange={(event) => onChange(event.target.value)} className={referenceInputClass} />
    </label>
  );
}

function EditorSelect({ label, value, options, onChange, placeholder }: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block min-w-0 text-xs">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <Select items={options} value={value || null} onValueChange={(next) => { if (typeof next === "string") onChange(next); }}>
        <SelectTrigger className="h-11 w-full md:h-9" aria-label={label}><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
      </Select>
    </label>
  );
}
