"use client";

/**
 * Inline cell editors for the CRM operator surface — compact, quiet
 * pickers that commit a single typed field without a drawer round-trip
 * (crm-operator-surface §3). Commit contract mirrors `task-cells.tsx`:
 * async commit, busy dim, the surface owns the wire + local patch.
 *
 * All dropdowns ride the project primitives (`Select`/`Popover`) — never a
 * native `<select>` (root CLAUDE.md).
 *
 * [COMP:app-web/crm-surface]
 */

import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DEAL_STAGES,
  type CrmCompanyRow,
  type DealStage,
} from "@/lib/api/crm";

export type CellCommit<T> = (next: T) => Promise<{ ok: boolean; error?: string }>;

/** Stage dot tints — pipeline-ordered warmth; won/lost close the loop. */
export const STAGE_DOT: Record<DealStage, string> = {
  lead: "bg-muted-foreground/50",
  qualified: "bg-sky-500",
  proposal: "bg-blue-500",
  negotiation: "bg-amber-500",
  won: "bg-emerald-500",
  lost: "bg-red-500/70",
};

const CELL_TRIGGER =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-md px-1.5 text-[13px] " +
  "text-foreground/90 transition-colors hover:bg-muted/70 disabled:opacity-50";

/** Stage pill cell — a `Select` over the six locked stages. */
export function StageCell({
  value,
  onCommit,
  disabled,
}: {
  value: DealStage;
  onCommit: CellCommit<DealStage>;
  disabled?: boolean;
}) {
  const t = useT().crmPage;
  const labels = t.stage as Record<string, string>;
  const [busy, setBusy] = useState(false);
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (typeof v !== "string" || v === value) return;
        setBusy(true);
        void onCommit(v as DealStage).finally(() => setBusy(false));
      }}
      disabled={disabled || busy}
      items={Object.fromEntries(DEAL_STAGES.map((s) => [s, labels[s] ?? s]))}
    >
      <SelectTrigger
        className={cn(
          CELL_TRIGGER,
          "w-auto border-0 bg-transparent shadow-none dark:bg-transparent",
          "[&>svg:last-child]:opacity-0 hover:[&>svg:last-child]:opacity-60",
          busy && "opacity-60",
        )}
      >
        <span className={cn("size-2 shrink-0 rounded-full", STAGE_DOT[value])} aria-hidden />
        <span className="truncate">{labels[value] ?? value}</span>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {DEAL_STAGES.map((s) => (
          <SelectItem key={s} value={s}>
            <span className={cn("size-2 shrink-0 rounded-full", STAGE_DOT[s])} aria-hidden />
            <span>{labels[s] ?? s}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Amount cell — quiet button revealing a number input; empty commits null. */
export function AmountCell({
  value,
  onCommit,
  disabled,
}: {
  value: number | null;
  onCommit: CellCommit<number | null>;
  disabled?: boolean;
}) {
  const t = useT().crmPage;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  function commit(raw: string) {
    setEditing(false);
    const trimmed = raw.trim();
    const next = trimmed.length === 0 ? null : Number(trimmed);
    if (next !== null && (!Number.isFinite(next) || next < 0)) return;
    if (next === value) return;
    setBusy(true);
    void onCommit(next).finally(() => setBusy(false));
  }

  if (editing) {
    return (
      <input
        type="number"
        min={0}
        step="any"
        autoFocus
        defaultValue={value ?? ""}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          }
        }}
        className="h-7 w-24 rounded-md bg-muted/50 px-1.5 text-[13px] outline-none ring-1 ring-ring/40"
      />
    );
  }

  return (
    <button
      type="button"
      disabled={disabled || busy}
      aria-label={t.amountLabel}
      onClick={() => setEditing(true)}
      className={cn(
        CELL_TRIGGER,
        "tabular-nums",
        value === null && "text-muted-foreground/60",
        busy && "opacity-60",
      )}
    >
      <span className="whitespace-nowrap">
        {value !== null ? `$${value.toLocaleString()}` : t.noAmountCell}
      </span>
    </button>
  );
}

/** Close-date cell — date input; clearing commits null; overdue reads red. */
export function CloseDateCell({
  value,
  overdue,
  onCommit,
  disabled,
}: {
  /** Calendar date `YYYY-MM-DD` or null. */
  value: string | null;
  /** Pre-computed by the surface (shared `overdue` predicate). */
  overdue: boolean;
  onCommit: CellCommit<string | null>;
  disabled?: boolean;
}) {
  const t = useT().crmPage;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  function commit(next: string) {
    setEditing(false);
    if (next === (value ?? "")) return;
    setBusy(true);
    void onCommit(next.length > 0 ? next : null).finally(() => setBusy(false));
  }

  if (editing) {
    return (
      <input
        type="date"
        autoFocus
        defaultValue={value ?? ""}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          }
        }}
        className="h-7 rounded-md bg-muted/50 px-1.5 text-[13px] outline-none ring-1 ring-ring/40"
      />
    );
  }

  return (
    <button
      type="button"
      disabled={disabled || busy}
      aria-label={t.closeDateLabel}
      onClick={() => setEditing(true)}
      className={cn(
        CELL_TRIGGER,
        "tabular-nums",
        value === null && "text-muted-foreground/60",
        overdue && "text-red-500",
        busy && "opacity-60",
      )}
    >
      <CalendarDays className="size-3.5 shrink-0 opacity-60" aria-hidden />
      <span className="whitespace-nowrap">
        {value
          ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })
          : t.noDate}
      </span>
    </button>
  );
}

/** Free-text cell (email / phone / domain) — click to edit; empty clears. */
export function TextFieldCell({
  value,
  placeholder,
  ariaLabel,
  inputType = "text",
  onCommit,
  disabled,
}: {
  value: string | null;
  placeholder: string;
  ariaLabel: string;
  inputType?: "text" | "email" | "tel";
  onCommit: CellCommit<string | null>;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  function commit(raw: string) {
    setEditing(false);
    const next = raw.trim().length > 0 ? raw.trim() : null;
    if (next === value) return;
    setBusy(true);
    void onCommit(next).finally(() => setBusy(false));
  }

  if (editing) {
    return (
      <input
        type={inputType}
        autoFocus
        defaultValue={value ?? ""}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          }
        }}
        className="h-7 w-full min-w-0 rounded-md bg-muted/50 px-1.5 text-[13px] outline-none ring-1 ring-ring/40"
      />
    );
  }

  return (
    <button
      type="button"
      disabled={disabled || busy}
      aria-label={ariaLabel}
      onClick={() => setEditing(true)}
      className={cn(
        CELL_TRIGGER,
        value === null && "text-muted-foreground/60",
        busy && "opacity-60",
      )}
    >
      <span className="truncate">{value ?? placeholder}</span>
    </button>
  );
}

/** Company link cell — searchable popover over the workspace's companies;
 *  the clear row commits null (unlink). */
export function CompanyCell({
  companyId,
  companies,
  onCommit,
  disabled,
}: {
  companyId: string | null;
  companies: readonly CrmCompanyRow[];
  onCommit: CellCommit<string | null>;
  disabled?: boolean;
}) {
  const t = useT().crmPage;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needle, setNeedle] = useState("");
  const current = companyId
    ? (companies.find((c) => c.id === companyId) ?? null)
    : null;

  function commit(nextId: string | null) {
    setOpen(false);
    setNeedle("");
    if (nextId === companyId) return;
    setBusy(true);
    void onCommit(nextId).finally(() => setBusy(false));
  }

  const q = needle.trim().toLowerCase();
  const options = q
    ? companies.filter((c) => c.name.toLowerCase().includes(q))
    : companies;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled || busy}
        aria-label={t.companyLabel}
        className={cn(CELL_TRIGGER, busy && "opacity-60")}
      >
        {current ? (
          <span className="truncate">{current.name}</span>
        ) : companyId ? (
          // Linked to a company the viewer can't see (or past the cap).
          <span className="text-muted-foreground/60">{t.companyHidden}</span>
        ) : (
          <span className="text-muted-foreground/60">{t.noCompany}</span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-72 w-64 overflow-y-auto p-1">
        <input
          type="text"
          autoFocus
          value={needle}
          placeholder={t.companySearchPlaceholder}
          onChange={(e) => setNeedle(e.target.value)}
          className="mb-1 h-7 w-full rounded-md border border-border bg-background px-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        />
        <button
          type="button"
          onClick={() => commit(null)}
          className={cn(
            "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted",
            !companyId && "bg-muted/60",
          )}
        >
          {t.noCompany}
        </button>
        {options.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => commit(c.id)}
            className={cn(
              "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
              companyId === c.id && "bg-muted/60",
            )}
          >
            <span className="truncate">{c.name}</span>
          </button>
        ))}
        {options.length === 0 && (
          <div className="px-2 py-1.5 text-[12px] text-muted-foreground/60">
            {t.companyNoMatch}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Tags cell — popover with removable chips + an add input; each change
 *  commits the full replacement tag set (the adjust wire's contract). */
export function TagsCell({
  tags,
  onCommit,
  disabled,
}: {
  tags: string[];
  onCommit: CellCommit<string[]>;
  disabled?: boolean;
}) {
  const t = useT().crmPage;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");

  function commit(next: string[]) {
    setBusy(true);
    void onCommit(next).finally(() => setBusy(false));
  }

  function addDraft() {
    const name = draft.trim();
    setDraft("");
    if (name.length === 0 || tags.includes(name)) return;
    commit([...tags, name]);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled || busy}
        aria-label={t.tagsLabel}
        className={cn(CELL_TRIGGER, busy && "opacity-60")}
      >
        {tags.length > 0 ? (
          <span className="flex min-w-0 items-center gap-1">
            {tags.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground border border-border"
              >
                {tag}
              </span>
            ))}
            {tags.length > 2 && (
              <span className="text-[11px] text-muted-foreground/60">
                +{tags.length - 2}
              </span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground/60">{t.noTags}</span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-2">
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => commit(tags.filter((x) => x !== tag))}
              title={t.removeTag}
              className="group inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground border border-border hover:border-destructive/50 hover:text-destructive"
            >
              {tag}
              <span aria-hidden>×</span>
            </button>
          ))}
          {tags.length === 0 && (
            <span className="text-[12px] text-muted-foreground/60">{t.noTags}</span>
          )}
        </div>
        <input
          type="text"
          value={draft}
          placeholder={t.addTagPlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addDraft();
            }
          }}
          className="mt-2 h-7 w-full rounded-md border border-border bg-background px-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      </PopoverContent>
    </Popover>
  );
}
