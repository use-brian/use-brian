"use client";

/**
 * Notion-style property primitives for the brain entry page (the detail
 * drawer's body). One row per property: icon + muted label on the left,
 * an inline-editable value on the right. Unset editable values render an
 * "Empty" placeholder; clicking a value edits it in place and commits on
 * blur / Enter (Escape cancels without closing the drawer).
 *
 * Commit contract: every editable value receives an async `onCommit` that
 * resolves `{ ok, error? }`. While the promise is pending the row dims;
 * on failure the draft reverts and the error renders under the row. The
 * caller (detail-drawer.tsx) owns the wire call + optimistic body patch.
 *
 * Spec: docs/architecture/brain/corrections.md → "Entry page view".
 * [COMP:app-web/brain-property-fields]
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { parseTagsInput, tagsEqual } from "@/components/brain/property-edit";

export type CommitResult = { ok: boolean; error?: string };
export type CommitFn<T> = (next: T) => Promise<CommitResult>;

// ── Row scaffold ───────────────────────────────────────────────────

/** One property row: icon + label column, value column. The label column is
 *  fixed so consecutive rows read as a table (the Notion rhythm). */
export function PropertyRow({
  icon,
  label,
  children,
  error,
}: {
  icon?: React.ReactNode;
  label: string;
  children: React.ReactNode;
  error?: string | null;
}) {
  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-[9.5rem_minmax(0,1fr)] items-start gap-x-3">
        <div className="flex h-9 min-w-0 items-center gap-2 text-sm text-muted-foreground">
          {icon && (
            <span className="shrink-0 text-muted-foreground/70 [&_svg]:size-4" aria-hidden>
              {icon}
            </span>
          )}
          <span className="truncate">{label}</span>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
      {error && (
        <p className="pl-[9.5rem] pb-1 text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Shared face for a clickable value cell (quiet until hovered). */
const VALUE_BUTTON_CLASS =
  "flex w-full min-h-9 items-center rounded-md px-1.5 py-1 -ml-1.5 text-left text-sm " +
  "hover:bg-muted/70 transition-colors disabled:pointer-events-none disabled:opacity-60";

function EmptyValue() {
  const t = useT();
  return (
    <span className="text-sm text-muted-foreground/60">
      {t.brainPage.detailDrawer.empty}
    </span>
  );
}

/** Read-only value cell. */
export function StaticProperty({
  icon,
  label,
  value,
  mono,
  children,
}: {
  icon?: React.ReactNode;
  label: string;
  value?: string;
  mono?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <PropertyRow icon={icon} label={label}>
      <div className="flex min-h-9 items-center py-1">
        {children ??
          (value && value.length > 0 ? (
            <span
              className={cn(
                "text-sm break-words whitespace-pre-wrap",
                mono && "font-mono text-[12px] leading-relaxed",
              )}
            >
              {value}
            </span>
          ) : (
            <EmptyValue />
          ))}
      </div>
    </PropertyRow>
  );
}

// ── Text property ──────────────────────────────────────────────────

export function TextProperty({
  icon,
  label,
  value,
  placeholder,
  onCommit,
  disabled,
  maxLength,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  placeholder?: string;
  onCommit: CommitFn<string>;
  disabled?: boolean;
  maxLength?: number;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commit() {
    setEditing(false);
    const next = draft.trim();
    if (next === value) return;
    setBusy(true);
    setError(null);
    const result = await onCommit(next);
    setBusy(false);
    if (!result.ok) {
      setDraft(value);
      setError(result.error ?? t.brainPage.detailDrawer.saveFailed);
    }
  }

  return (
    <PropertyRow icon={icon} label={label} error={error}>
      {editing ? (
        <input
          type="text"
          autoFocus
          value={draft}
          maxLength={maxLength}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape") {
              // Cancel the edit without letting the drawer's global
              // Escape-close fire.
              e.stopPropagation();
              setDraft(value);
              setEditing(false);
            }
          }}
          className="w-full min-h-9 rounded-md bg-muted/50 px-1.5 py-1 -ml-1.5 text-sm outline-none ring-1 ring-ring/40"
        />
      ) : (
        <button
          type="button"
          disabled={disabled || busy}
          aria-label={format(t.brainPage.detailDrawer.editValue, { label })}
          onClick={() => {
            setDraft(value);
            setError(null);
            setEditing(true);
          }}
          className={cn(VALUE_BUTTON_CLASS, busy && "opacity-60")}
        >
          {value.length > 0 ? (
            <span className="break-words whitespace-pre-wrap">{value}</span>
          ) : (
            <span className="text-muted-foreground/60">
              {placeholder ?? t.brainPage.detailDrawer.empty}
            </span>
          )}
        </button>
      )}
    </PropertyRow>
  );
}

// ── Select property ────────────────────────────────────────────────

export type SelectPropertyOption = {
  value: string;
  label: string;
  /** Optional state-dot tint (e.g. task status / sensitivity). With a dot
   *  the value renders as a soft Notion-style pill (muted bg, colored dot,
   *  sentence-case label); without one it renders as plain text. */
  dotClassName?: string;
};

export function SelectProperty({
  icon,
  label,
  value,
  options,
  onCommit,
  disabled,
  readOnly,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  options: SelectPropertyOption[];
  onCommit?: CommitFn<string>;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = options.find((o) => o.value === value);
  const pill = active ? (
    active.dotClassName ? (
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-sm leading-none">
        <span
          className={cn("size-2 shrink-0 rounded-full", active.dotClassName)}
          aria-hidden
        />
        <span className="truncate">{active.label}</span>
      </span>
    ) : (
      <span className="text-sm">{active.label}</span>
    )
  ) : value ? (
    <span className="text-sm">{value}</span>
  ) : (
    <EmptyValue />
  );

  if (readOnly || !onCommit) {
    return (
      <PropertyRow icon={icon} label={label}>
        <div className="flex min-h-9 items-center py-1">{pill}</div>
      </PropertyRow>
    );
  }

  async function commit(next: string) {
    if (!next || next === value || !onCommit) return;
    setBusy(true);
    setError(null);
    const result = await onCommit(next);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? t.brainPage.detailDrawer.saveFailed);
    }
  }

  const items = Object.fromEntries(options.map((o) => [o.value, o.label]));

  return (
    <PropertyRow icon={icon} label={label} error={error}>
      <Select
        value={value}
        onValueChange={(v) => {
          if (typeof v === "string") void commit(v);
        }}
        disabled={disabled || busy}
        items={items}
      >
        <SelectTrigger
          aria-label={format(t.brainPage.detailDrawer.editValue, { label })}
          className={cn(
            // Quiet, Notion-like: no border until hover, full-width target.
            "w-full min-h-9 h-auto justify-start border-0 bg-transparent px-1.5 py-1 -ml-1.5",
            "hover:bg-muted/70 dark:bg-transparent dark:hover:bg-muted/70",
            "[&>svg:last-child]:opacity-0 hover:[&>svg:last-child]:opacity-60",
            busy && "opacity-60",
          )}
        >
          {pill}
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </PropertyRow>
  );
}

// ── Date property ──────────────────────────────────────────────────

export function DateProperty({
  icon,
  label,
  /** `YYYY-MM-DD` or empty. */
  value,
  onCommit,
  disabled,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  onCommit: CommitFn<string>;
  disabled?: boolean;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commit(next: string) {
    setEditing(false);
    if (next === value) return;
    setBusy(true);
    setError(null);
    const result = await onCommit(next);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? t.brainPage.detailDrawer.saveFailed);
    }
  }

  const display =
    value.length > 0
      ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "";

  return (
    <PropertyRow icon={icon} label={label} error={error}>
      {editing ? (
        <input
          type="date"
          autoFocus
          defaultValue={value}
          onBlur={(e) => void commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit((e.target as HTMLInputElement).value);
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setEditing(false);
            }
          }}
          className="min-h-9 rounded-md bg-muted/50 px-1.5 py-1 -ml-1.5 text-sm outline-none ring-1 ring-ring/40"
        />
      ) : (
        <div className="group/date flex items-center gap-1">
          <button
            type="button"
            disabled={disabled || busy}
            aria-label={format(t.brainPage.detailDrawer.editValue, { label })}
            onClick={() => {
              setError(null);
              setEditing(true);
            }}
            className={cn(VALUE_BUTTON_CLASS, "w-auto flex-1", busy && "opacity-60")}
          >
            {display.length > 0 ? display : <EmptyValue />}
          </button>
          {value.length > 0 && !busy && !disabled && (
            <button
              type="button"
              aria-label={t.brainPage.detailDrawer.clearValue}
              onClick={() => void commit("")}
              className="h-6 w-6 shrink-0 rounded text-muted-foreground/50 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/date:opacity-100"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden
                className="mx-auto"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      )}
    </PropertyRow>
  );
}

// ── Tags property ──────────────────────────────────────────────────

export function TagsProperty({
  icon,
  label,
  tags,
  onCommit,
  disabled,
  readOnly,
  placeholder,
}: {
  icon?: React.ReactNode;
  label: string;
  tags: string[];
  onCommit?: CommitFn<string[]>;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tags.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chips =
    tags.length > 0 ? (
      <span className="flex flex-wrap items-center gap-1 py-0.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground border border-border"
          >
            {tag}
          </span>
        ))}
      </span>
    ) : (
      <EmptyValue />
    );

  if (readOnly || !onCommit) {
    return (
      <PropertyRow icon={icon} label={label}>
        <div className="flex min-h-9 items-center py-1">{chips}</div>
      </PropertyRow>
    );
  }

  async function commit() {
    setEditing(false);
    const next = parseTagsInput(draft);
    if (tagsEqual(next, tags)) return;
    setBusy(true);
    setError(null);
    const result = await onCommit!(next);
    setBusy(false);
    if (!result.ok) {
      setDraft(tags.join(", "));
      setError(result.error ?? t.brainPage.detailDrawer.saveFailed);
    }
  }

  return (
    <PropertyRow icon={icon} label={label} error={error}>
      {editing ? (
        <input
          type="text"
          autoFocus
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(tags.join(", "));
              setEditing(false);
            }
          }}
          className="w-full min-h-9 rounded-md bg-muted/50 px-1.5 py-1 -ml-1.5 text-sm outline-none ring-1 ring-ring/40"
        />
      ) : (
        <button
          type="button"
          disabled={disabled || busy}
          aria-label={format(t.brainPage.detailDrawer.editValue, { label })}
          onClick={() => {
            setDraft(tags.join(", "));
            setError(null);
            setEditing(true);
          }}
          className={cn(VALUE_BUTTON_CLASS, busy && "opacity-60")}
        >
          {chips}
        </button>
      )}
    </PropertyRow>
  );
}

// ── Page title ─────────────────────────────────────────────────────

/**
 * The big Notion-page title. Editable flavour renders an auto-growing
 * textarea styled as the heading (Tailwind v4 `field-sizing-content`);
 * Enter commits, Escape reverts, blur commits.
 */
export function PageTitle({
  value,
  editable,
  onCommit,
  placeholder,
}: {
  value: string;
  editable?: boolean;
  onCommit?: CommitFn<string>;
  placeholder?: string;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const committedRef = useRef(value);

  // Resync when the row underneath swaps (or a commit re-anchored it).
  useEffect(() => {
    committedRef.current = value;
    setDraft(value);
  }, [value]);

  async function commit() {
    if (!onCommit) return;
    const next = draft.trim();
    if (next === committedRef.current) {
      setDraft(committedRef.current);
      return;
    }
    if (next.length === 0) {
      // Empty titles are rejected server-side; revert quietly.
      setDraft(committedRef.current);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await onCommit(next);
    setBusy(false);
    if (!result.ok) {
      setDraft(committedRef.current);
      setError(result.error ?? t.brainPage.detailDrawer.saveFailed);
    }
  }

  if (!editable || !onCommit) {
    return (
      <h2 className="text-3xl font-bold leading-tight break-words">
        {value}
      </h2>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <textarea
        value={draft}
        rows={1}
        disabled={busy}
        placeholder={placeholder ?? t.brainPage.detailDrawer.titlePlaceholder}
        aria-label={t.brainPage.detailDrawer.editTitle}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void commit();
            (e.target as HTMLTextAreaElement).blur();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            setDraft(committedRef.current);
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        className={cn(
          "w-full resize-none field-sizing-content bg-transparent",
          "text-3xl font-bold leading-tight break-words",
          // The background swap is the focus cue; suppress the global
          // fluid :focus-visible ring (it would frame the whole title,
          // the same reason the doc editor strips it).
          "rounded-md -mx-1.5 px-1.5 py-0.5 outline-none focus-visible:shadow-none",
          "hover:bg-muted/50 focus:bg-muted/50 transition-colors",
          "placeholder:text-muted-foreground/50",
          busy && "opacity-60",
        )}
      />
      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ── "N more properties" disclosure ─────────────────────────────────

/**
 * Notion's collapsed-properties row: secondary rows (audit metadata,
 * free-form attributes, generic body fields) hide behind a quiet
 * "N more properties" toggle so the visible list stays the handful of
 * rows a user actually edits.
 */
export function MoreProperties({
  count,
  children,
}: {
  count: number;
  children: React.ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  if (count <= 0) return null;

  return (
    <>
      {open && children}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-h-9 items-center gap-2 rounded-md px-1.5 -ml-1.5 text-left text-sm text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground transition-colors"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={cn("shrink-0 transition-transform", open && "rotate-180")}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
        {open
          ? t.brainPage.detailDrawer.fewerProperties
          : format(t.brainPage.detailDrawer.moreProperties, { count })}
      </button>
    </>
  );
}
