"use client";

import { useEffect, useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import {
  updateCrmCustomFields,
  type CrmConfig,
  type CrmData,
} from "@/lib/api/crm";
import type { CrmRecordRef } from "./crm-record-detail";
import { useT } from "@/lib/i18n/client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";

export function CrmCustomFields({
  workspaceId,
  record,
  config,
  data,
  onChanged,
}: {
  workspaceId: string;
  record: CrmRecordRef;
  config: CrmConfig;
  data: CrmData;
  onChanged: () => void;
}) {
  const t = useT().crmPage.r2;
  const [error, setError] = useState<string | null>(null);
  const entityKind = record.kind === "contact" ? "person" : record.kind;
  const values = record.row.customFields ?? {};

  const fields = useMemo(
    () => config.fields.filter((field) => field.entityKind === entityKind),
    [config, entityKind],
  );

  async function saveField(key: string, value: unknown) {
    setError(null);
    try {
      await updateCrmCustomFields(workspaceId, record.row.id, { [key]: value });
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.updateFailed);
    }
  }

  if (fields.length === 0) return null;

  return (
    <section className="mt-4 border-t border-border/60 pt-4">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        <SlidersHorizontal className="size-3.5" aria-hidden />
        {t.customFields}
      </div>
      <div className="space-y-2">
        {fields.map((field) => (
          <FieldEditor
            key={field.id}
            label={field.label}
            type={field.fieldType}
            options={field.options}
            referenceItems={field.fieldType === "entity_reference" ? [
              ...(field.options.includes("person") ? data.contacts : []),
              ...(field.options.includes("company") ? data.companies : []),
              ...(field.options.includes("deal") ? data.deals : []),
            ].map((row) => ({ value: row.id, label: row.name })) : []}
            value={values[field.fieldKey]}
            onCommit={(value) => void saveField(field.fieldKey, value)}
          />
        ))}
      </div>
      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
    </section>
  );
}

function FieldEditor({
  label,
  type,
  options,
  referenceItems,
  value,
  onCommit,
}: {
  label: string;
  type: string;
  options: string[];
  referenceItems: Array<{ value: string; label: string }>;
  value: unknown;
  onCommit: (value: unknown) => void;
}) {
  const t = useT().crmPage.r2;
  const [draft, setDraft] = useState(() => Array.isArray(value) ? value.join(", ") : String(value ?? ""));
  useEffect(() => {
    setDraft(Array.isArray(value) ? value.join(", ") : String(value ?? ""));
  }, [value]);

  if (type === "entity_reference") {
    const items = [
      { value: "__empty__", label: t.emptyValue },
      ...(typeof value === "string" && !referenceItems.some((item) => item.value === value)
        ? [{ value, label: t.referenceUnavailable }]
        : []),
      ...referenceItems,
    ];
    return (
      <label className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <SearchableSelect
          value={typeof value === "string" ? value : "__empty__"}
          onValueChange={(next) => onCommit(next === "__empty__" ? null : next)}
          items={items}
          placeholder={t.pickValue}
          searchPlaceholder={t.searchRecords}
          emptyMessage={t.noMatchingRecords}
          className="h-8 text-xs"
        />
      </label>
    );
  }

  if (type === "boolean" || type === "single_select") {
    const optionsForSelect = type === "boolean" ? ["true", "false"] : options;
    return (
      <label className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <Select
          value={value == null ? undefined : String(value)}
          onValueChange={(next) => onCommit(
            next === "__empty__" ? null : type === "boolean" ? next === "true" : next,
          )}
        >
          <SelectTrigger className="w-full"><SelectValue placeholder={t.emptyValue} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__empty__">{t.emptyValue}</SelectItem>
            {optionsForSelect.map((option) => (
              <SelectItem key={option} value={option}>
                {type === "boolean" ? (option === "true" ? t.yes : t.no) : option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    );
  }

  return (
    <label className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        type={type === "number" ? "number" : type === "date" ? "date" : "text"}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (type === "number") onCommit(draft === "" ? null : Number(draft));
          else if (type === "multi_select") {
            const selected = draft.split(",").map((item) => item.trim()).filter((item) => options.includes(item));
            onCommit(selected);
          } else onCommit(draft || null);
        }}
        placeholder={type === "multi_select" ? options.join(", ") : t.emptyValue}
        className="h-8 w-full rounded-lg border border-border bg-background px-2.5 text-xs outline-none"
      />
    </label>
  );
}
