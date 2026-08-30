"use client";

/** Shared dynamic CRM segment builder and addressable preview. [COMP:app-web/crm-operations] */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Plus, RefreshCw, UsersRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  archiveCrmSegment,
  listCrmSegments,
  previewCrmSegment,
  saveCrmSegment,
  type CrmSegment,
  type CrmSegmentCatalogEntry,
  type CrmSegmentEntityKind,
  type CrmSegmentOperator,
  type CrmSegmentPredicate,
  type CrmSegmentRule,
} from "@/lib/api/crm";
import { useT } from "@/lib/i18n/client";

const UNARY = new Set<CrmSegmentOperator>(["is_empty", "is_not_empty"]);

function firstRule(catalog: CrmSegmentCatalogEntry[]): CrmSegmentRule | null {
  const field = catalog[0];
  if (!field) return null;
  const operator = field.operators[0] ?? "eq";
  return {
    type: "rule",
    family: field.family,
    field: field.field,
    operator,
    ...(UNARY.has(operator) ? {} : { value: field.valueType === "boolean" ? true : "" }),
  };
}

function defaultPredicate(catalog: CrmSegmentCatalogEntry[]): CrmSegmentPredicate {
  const rule = firstRule(catalog);
  return { type: "group", combinator: "and", items: rule ? [rule] : [] };
}

function fieldId(field: Pick<CrmSegmentCatalogEntry, "family" | "field">): string {
  return `${field.family}:${field.field}`;
}

function ruleForField(field: CrmSegmentCatalogEntry): CrmSegmentRule {
  const operator = field.operators[0] ?? "eq";
  return {
    type: "rule",
    family: field.family,
    field: field.field,
    operator,
    ...(UNARY.has(operator) ? {} : { value: field.valueType === "boolean" ? true : "" }),
  };
}

function valueForOperator(rule: CrmSegmentRule, operator: CrmSegmentOperator): CrmSegmentRule {
  if (UNARY.has(operator)) return { ...rule, operator, value: undefined };
  const previous = Array.isArray(rule.value) ? rule.value : rule.value ?? "";
  if (operator === "in" || operator === "not_in") {
    return { ...rule, operator, value: Array.isArray(previous) ? previous : String(previous).split(",").map((part) => part.trim()).filter(Boolean) };
  }
  return { ...rule, operator, value: Array.isArray(previous) ? previous[0] ?? "" : previous };
}

function RuleEditor({
  rule,
  catalog,
  disabled,
  onChange,
  onRemove,
}: {
  rule: CrmSegmentRule;
  catalog: CrmSegmentCatalogEntry[];
  disabled: boolean;
  onChange: (rule: CrmSegmentRule) => void;
  onRemove: () => void;
}) {
  const t = useT().crmPage.operations;
  const field = catalog.find((item) => item.family === rule.family && item.field === rule.field) ?? catalog[0];
  const fieldItems = catalog.map((item) => ({ value: fieldId(item), label: `${t.segmentFamilyLabels[item.family]}: ${item.label}` }));
  const operatorItems = (field?.operators ?? []).map((operator) => ({ value: operator, label: t.segmentOperatorLabels[operator] }));
  const setValue = (raw: string | boolean) => {
    if (!field) return;
    let value: unknown = raw;
    if (rule.operator === "in" || rule.operator === "not_in") {
      value = String(raw).split(",").map((part) => part.trim()).filter(Boolean);
    } else if (field.valueType === "number") {
      value = raw === "" ? "" : Number(raw);
    }
    onChange({ ...rule, value });
  };
  return (
    <div className="grid gap-2 rounded-lg border border-border/60 bg-background p-2 sm:grid-cols-[minmax(11rem,1.5fr)_minmax(8rem,1fr)_minmax(10rem,1.3fr)_auto]">
      <Select items={fieldItems} value={field ? fieldId(field) : undefined} onValueChange={(value) => {
        if (typeof value !== "string") return;
        const next = catalog.find((item) => fieldId(item) === value);
        if (next) onChange(ruleForField(next));
      }} disabled={disabled}>
        <SelectTrigger className="w-full"><SelectValue placeholder={t.segmentField} /></SelectTrigger>
        <SelectContent>{catalog.map((item) => <SelectItem key={fieldId(item)} value={fieldId(item)}>{t.segmentFamilyLabels[item.family]}: {item.label}</SelectItem>)}</SelectContent>
      </Select>
      <Select items={operatorItems} value={rule.operator} onValueChange={(value) => {
        if (typeof value === "string") onChange(valueForOperator(rule, value as CrmSegmentOperator));
      }} disabled={disabled || !field}>
        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{field?.operators.map((operator) => <SelectItem key={operator} value={operator}>{t.segmentOperatorLabels[operator]}</SelectItem>)}</SelectContent>
      </Select>
      {UNARY.has(rule.operator) ? <div className="flex items-center text-xs text-muted-foreground">{t.segmentNoValue}</div> : field?.validValues?.length ? (
        <Select
          items={field.validValues.map((value) => ({ value, label: value }))}
          value={typeof rule.value === "string" ? rule.value : undefined}
          onValueChange={(value) => typeof value === "string" && setValue(value)}
          disabled={disabled}
        >
          <SelectTrigger className="w-full"><SelectValue placeholder={t.segmentValue} /></SelectTrigger>
          <SelectContent>{field.validValues.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
        </Select>
      ) : field?.valueType === "boolean" ? (
        <Select value={String(rule.value ?? true)} onValueChange={(value) => setValue(value === "true")} disabled={disabled}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="true">{t.yes}</SelectItem><SelectItem value="false">{t.no}</SelectItem></SelectContent>
        </Select>
      ) : (
        <input
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus:border-ring"
          type={field?.valueType === "number" ? "number" : field?.valueType === "date" ? "datetime-local" : "text"}
          value={Array.isArray(rule.value) ? rule.value.join(", ") : String(rule.value ?? "")}
          placeholder={rule.operator === "in" || rule.operator === "not_in" ? t.segmentValuesPlaceholder : t.segmentValue}
          onChange={(event) => setValue(event.target.value)}
          disabled={disabled}
        />
      )}
      <Button type="button" variant="ghost" size="icon" onClick={onRemove} disabled={disabled} aria-label={t.segmentRemoveRule}><X className="size-4" /></Button>
    </div>
  );
}

function GroupEditor({
  group,
  catalog,
  depth,
  disabled,
  onChange,
}: {
  group: CrmSegmentPredicate;
  catalog: CrmSegmentCatalogEntry[];
  depth: number;
  disabled: boolean;
  onChange: (group: CrmSegmentPredicate) => void;
}) {
  const t = useT().crmPage.operations;
  const replace = (index: number, item: CrmSegmentPredicate | CrmSegmentRule) => onChange({ ...group, items: group.items.map((current, currentIndex) => currentIndex === index ? item : current) });
  const remove = (index: number) => onChange({ ...group, items: group.items.filter((_item, currentIndex) => currentIndex !== index) });
  const addRule = () => {
    const rule = firstRule(catalog);
    if (rule && group.items.length < 50) onChange({ ...group, items: [...group.items, rule] });
  };
  const addGroup = () => {
    const rule = firstRule(catalog);
    if (rule && depth < 4 && group.items.length < 50) onChange({ ...group, items: [...group.items, { type: "group", combinator: "and", items: [rule] }] });
  };
  return (
    <div className={depth > 1 ? "rounded-xl border border-border/60 bg-muted/20 p-3" : "space-y-3"}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t.segmentMatch}</span>
        <Select value={group.combinator} onValueChange={(value) => value && onChange({ ...group, combinator: value as "and" | "or" })} disabled={disabled}>
          <SelectTrigger className="h-7 w-32"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="and">{t.segmentAllRules}</SelectItem><SelectItem value="or">{t.segmentAnyRule}</SelectItem></SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        {group.items.map((item, index) => item.type === "group" ? (
          <div key={index} className="relative">
            <GroupEditor group={item} catalog={catalog} depth={depth + 1} disabled={disabled} onChange={(next) => replace(index, next)} />
            <Button type="button" variant="ghost" size="sm" className="mt-1" onClick={() => remove(index)} disabled={disabled}>{t.segmentRemoveGroup}</Button>
          </div>
        ) : <RuleEditor key={index} rule={item} catalog={catalog} disabled={disabled} onChange={(next) => replace(index, next)} onRemove={() => remove(index)} />)}
      </div>
      <div className="mt-2 flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={addRule} disabled={disabled || !catalog.length || group.items.length >= 50}><Plus className="mr-1 size-3.5" />{t.segmentAddRule}</Button>
        {depth < 4 && <Button type="button" variant="ghost" size="sm" onClick={addGroup} disabled={disabled || !catalog.length || group.items.length >= 50}>{t.segmentAddGroup}</Button>}
      </div>
    </div>
  );
}

export function CrmSegmentsPanel({ workspaceId, selectedId, onSelect }: { workspaceId: string; selectedId: string | null; onSelect: (segmentId: string | null) => void }) {
  const t = useT().crmPage.operations;
  const [entityKind, setEntityKind] = useState<CrmSegmentEntityKind>("person");
  const [segments, setSegments] = useState<CrmSegment[]>([]);
  const [catalog, setCatalog] = useState<CrmSegmentCatalogEntry[]>([]);
  const [draft, setDraft] = useState<CrmSegment | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewCrmSegment>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await listCrmSegments(workspaceId, entityKind);
      setSegments(result.segments); setCatalog(result.catalog);
      const selected = result.segments.find((segment) => segment.id === selectedId) ?? result.segments[0] ?? null;
      setDraft(selected);
      if (selected?.id !== selectedId) onSelect(selected?.id ?? null);
    } catch { setError(t.segmentsLoadFailed); }
    finally { setLoading(false); }
  }, [workspaceId, entityKind, selectedId, onSelect, t.segmentsLoadFailed]);

  useEffect(() => { void reload(); }, [workspaceId, entityKind]);
  useEffect(() => {
    const selected = segments.find((segment) => segment.id === selectedId);
    if (selected) setDraft(selected);
  }, [selectedId, segments]);
  useEffect(() => {
    if (!draft?.id) { setPreview(null); return; }
    void previewCrmSegment(workspaceId, draft.id).then(setPreview).catch(() => setError(t.segmentPreviewFailed));
  }, [workspaceId, draft?.id, draft?.version, t.segmentPreviewFailed]);

  const newSegment = () => {
    setDraft({
      id: "", segmentKey: "", name: "", description: "", entityKind,
      predicate: defaultPredicate(catalog), version: 0, archivedAt: null,
      createdAt: "", updatedAt: "",
    });
    setPreview(null); onSelect(null);
  };
  const canSave = Boolean(draft?.name.trim() && /^[a-z][a-z0-9_-]{0,62}$/.test(draft.segmentKey) && draft.predicate.items.length > 0);
  async function save() {
    if (!draft || !canSave || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await saveCrmSegment(workspaceId, {
        segmentId: draft.id || undefined,
        segmentKey: draft.segmentKey,
        name: draft.name.trim(),
        description: draft.description.trim(),
        entityKind: draft.entityKind,
        predicate: draft.predicate,
        expectedVersion: draft.version || undefined,
      });
      setDraft(result.record); onSelect(result.record.id);
      const listed = await listCrmSegments(workspaceId, entityKind);
      setSegments(listed.segments); setCatalog(listed.catalog);
    } catch { setError(t.segmentSaveFailed); }
    finally { setBusy(false); }
  }
  async function archive() {
    if (!draft?.id || busy) return;
    const confirmed = await confirmDialog({ title: t.segmentArchiveTitle, description: t.segmentArchiveDescription.replace("{name}", draft.name), confirmLabel: t.archive, cancelLabel: t.cancel, variant: "destructive" });
    if (!confirmed) return;
    setBusy(true); setError(null);
    try { await archiveCrmSegment(workspaceId, draft.id, draft.version); onSelect(null); await reload(); }
    catch { setError(t.segmentSaveFailed); }
    finally { setBusy(false); }
  }

  const snapshot = useMemo(() => preview?.snapshotIds.join(", ") ?? "", [preview]);
  return (
    <div className="flex h-full min-h-0 flex-1 max-md:flex-col" data-crm-segments-panel>
      <aside className="w-80 shrink-0 overflow-y-auto border-r border-border/60 max-md:max-h-[40%] max-md:w-full max-md:border-b max-md:border-r-0">
        <div className="sticky top-0 z-10 space-y-2 border-b border-border/60 bg-background p-3">
          <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2 text-sm font-semibold"><UsersRound className="size-4" />{t.segments}</div><Button type="button" size="sm" variant="outline" onClick={newSegment}><Plus className="mr-1 size-3.5" />{t.segmentNew}</Button></div>
          <Select value={entityKind} onValueChange={(value) => value && setEntityKind(value as CrmSegmentEntityKind)} disabled={busy}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{(["person", "company", "deal"] as const).map((kind) => <SelectItem key={kind} value={kind}>{t.segmentEntityLabels[kind]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {error && <div className="p-3 text-xs text-destructive">{error}</div>}
        {loading ? <div className="p-3 text-xs text-muted-foreground">{t.loading}</div> : segments.length === 0 ? <div className="p-3 text-xs text-muted-foreground">{t.noSegments}</div> : segments.map((segment) => <button type="button" key={segment.id} className={`block w-full border-b border-border/40 px-3 py-3 text-left text-xs ${segment.id === draft?.id ? "bg-accent" : "hover:bg-accent/50"}`} onClick={() => { setDraft(segment); onSelect(segment.id); }}><div className="font-medium">{segment.name}</div><div className="mt-1 font-mono text-[10px] text-muted-foreground">{segment.segmentKey} · v{segment.version}</div></button>)}
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-5">
        {!draft ? <div className="text-sm text-muted-foreground">{t.pickSegment}</div> : <div className="mx-auto max-w-5xl space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-lg font-semibold">{draft.id ? draft.name : t.segmentNew}</h2><p className="text-xs text-muted-foreground">{t.segmentsHelp}</p></div>
            <div className="flex gap-2"><Button type="button" onClick={() => void save()} disabled={!canSave || busy}>{t.segmentSave}</Button>{draft.id && <Button type="button" variant="outline" onClick={() => void archive()} disabled={busy}><Archive className="mr-1 size-3.5" />{t.archive}</Button>}</div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.segmentName}</span><input className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} disabled={busy} /></label>
            <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.segmentKey}</span><input className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-sm" value={draft.segmentKey} onChange={(event) => setDraft({ ...draft, segmentKey: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "_") })} disabled={busy || Boolean(draft.id)} /></label>
            <label className="text-xs sm:col-span-2"><span className="mb-1 block text-muted-foreground">{t.segmentDescription}</span><textarea className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm" rows={2} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} disabled={busy} /></label>
          </div>
          <section><h3 className="mb-2 text-sm font-semibold">{t.segmentRules}</h3><GroupEditor group={draft.predicate} catalog={catalog} depth={1} disabled={busy} onChange={(predicate) => setDraft({ ...draft, predicate })} /></section>
          {draft.id && <section className="rounded-xl border border-border/60 p-4"><div className="flex items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">{t.segmentPreview}</h3><p className="text-xs text-muted-foreground">{preview ? t.segmentCount.replace("{count}", String(preview.count)) : t.loading}</p></div><Button type="button" variant="ghost" size="sm" onClick={() => void previewCrmSegment(workspaceId, draft.id).then(setPreview).catch(() => setError(t.segmentPreviewFailed))}><RefreshCw className="mr-1 size-3.5" />{t.refresh}</Button></div>{preview?.rows.length ? <ul className="mt-3 divide-y divide-border/50">{preview.rows.map((row) => <li key={row.id} className="flex items-center justify-between gap-3 py-2 text-xs"><span>{row.name}</span><code className="truncate text-[10px] text-muted-foreground">{row.id}</code></li>)}</ul> : preview ? <p className="mt-3 text-xs text-muted-foreground">{t.segmentPreviewEmpty}</p> : null}<details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">{t.segmentSnapshot.replace("{count}", String(preview?.snapshotIds.length ?? 0))}</summary><p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">{snapshot || t.none}</p></details></section>}
        </div>}
      </main>
    </div>
  );
}
