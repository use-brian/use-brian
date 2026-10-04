"use client";

/** Staff-console building blocks: page headers, tiles, status pills, responsive tables, choice controls. [COMP:app-web/association] */
import Link from "next/link";
import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

export type AssociationTone = "success" | "info" | "warning" | "danger" | "neutral";
const TONE_CLASS: Record<AssociationTone, string> = {
  success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  info: "bg-primary/10 text-primary",
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "bg-destructive/10 text-destructive",
  neutral: "bg-muted text-muted-foreground",
};
const STATUS_TONE: Record<string, AssociationTone> = {
  paid: "success", active: "success", published: "success", on_sale: "success", settled: "success", applied: "success",
  checked_in: "success", attended: "success", converted: "success", confirmed: "success", registered: "success", enabled: "success", delivered: "success", redeemed: "success",
  pending: "warning", draft: "warning", waiting: "warning", offered: "warning", outstanding: "warning", reserved: "warning",
  draining: "warning", retry: "warning", processing: "warning", leased: "warning", sold_out: "warning", expired: "warning",
  failed: "danger", cancelled: "danger", refunded: "danger", reversed: "danger", needs_reconciliation: "danger", no_show: "danger",
  disabled: "danger", closed: "neutral", completed: "neutral", revoked: "danger",
};
export function associationStatusTone(status: string): AssociationTone { return STATUS_TONE[status] ?? "neutral"; }

/** Coloured status label. Falls back to the raw status when no dictionary label exists. */
export function StatusPill({ status, label, tone, className }: { status: string; label?: ReactNode; tone?: AssociationTone; className?: string }) {
  const t = useT().associationPage;
  const options = t.manage.options as Record<string, string>, orders = t.orderStates as Record<string, string>;
  return <span className={cn("inline-flex w-fit shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap", TONE_CLASS[tone ?? associationStatusTone(status)], className)}>{label ?? options[status] ?? orders[status] ?? status}</span>;
}

export function PageHeader({ eyebrow, title, description, back, actions, children, level = 1 }: {
  eyebrow?: string; title: string; description?: string; back?: { label: string; href?: string; onClick?: () => void }; actions?: ReactNode; children?: ReactNode; level?: 1 | 2;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return <header className="space-y-3">
    {back ? back.href
      ? <Link href={back.href} className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground md:min-h-8"><ArrowLeft aria-hidden className="size-4" />{back.label}</Link>
      : <Button type="button" variant="ghost" className="-ml-2 min-h-11 md:min-h-8" onClick={back.onClick}><ArrowLeft aria-hidden className="size-4" />{back.label}</Button>
      : null}
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        {eyebrow ? <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{eyebrow}</p> : null}
        <Heading className={cn("font-semibold tracking-tight", level === 1 ? "text-2xl md:text-3xl" : "text-xl")}>{title}</Heading>
        {description ? <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
    {children}
  </header>;
}

export function StatTile({ label, value, suffix, hint, href, tone = "neutral" }: { label: string; value: number | string; suffix?: string; hint?: string; href?: string; tone?: AssociationTone }) {
  const body = <>
    <p className="text-sm text-muted-foreground">{label}</p>
    <p className={cn("mt-1 text-3xl font-semibold tracking-tight tabular-nums", tone === "danger" ? "text-destructive" : tone === "warning" ? "text-amber-700 dark:text-amber-300" : "")}>{value}{suffix ? <span className="text-lg text-muted-foreground">{suffix}</span> : null}</p>
    {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
  </>;
  const className = "block min-h-8 max-sm:min-h-11 rounded-2xl border border-border bg-background p-5";
  return href ? <Link href={href} className={cn(className, "transition-colors hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-ring")} data-stat-tile>{body}</Link>
    : <div className={className} data-stat-tile>{body}</div>;
}

export function EmptyState({ icon: Icon, title, description, action }: { icon?: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  return <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-12 text-center" data-empty-state>
    {Icon ? <span className="rounded-xl bg-muted p-3 text-muted-foreground"><Icon aria-hidden className="size-6" /></span> : null}
    <p className="font-medium">{title}</p>
    {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
    {action}
  </div>;
}

export function InlineNotice({ tone = "info", title, children, action, className }: { tone?: AssociationTone; title?: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return <div role={tone === "danger" ? "alert" : "status"} className={cn("flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm", TONE_CLASS[tone], tone === "neutral" ? "text-foreground" : "", className)}>
    <div className="min-w-0 space-y-0.5">{title ? <p className="font-medium">{title}</p> : null}{children ? <div>{children}</div> : null}</div>
    {action}
  </div>;
}

/** Segmented pill control (the CRM section-switch recipe). */
export function Segmented<V extends string>({ label, value, options, onChange, className }: { label: string; value: V; options: readonly { value: V; label: string; count?: number }[]; onChange: (value: V) => void; className?: string }) {
  return <div role="group" aria-label={label} className={cn("inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-sidebar-accent/60 p-0.5", className)}>
    {options.map(option => <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}
      className={cn("inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm transition-colors md:min-h-7 md:text-[12.5px]", value === option.value ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>
      {option.label}{option.count !== undefined ? <span className="text-[11px] text-muted-foreground tabular-nums">{option.count}</span> : null}
    </button>)}
  </div>;
}

/** Radio group rendered as cards with a one-line hint; arrow keys move the choice. */
export function ChoiceCards<V extends string>({ label, value, options, onChange, disabled = false, columns = 2 }: {
  label: string; value: V; options: readonly { value: V; label: string; hint?: string; icon?: LucideIcon }[]; onChange: (value: V) => void; disabled?: boolean; columns?: 2 | 3 | 4;
}) {
  const group = useRef<HTMLDivElement>(null);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = options[(index + delta + options.length) % options.length]!;
    onChange(next.value);
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[(index + delta + options.length) % options.length]?.focus();
  }
  return <div className="col-span-full min-w-0 space-y-1.5 text-sm">
    <p className="font-medium">{label}</p>
    <div ref={group} role="radiogroup" aria-label={label} className={cn("grid gap-2", columns === 4 ? "sm:grid-cols-4" : columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
      {options.map((option, index) => { const Icon = option.icon, checked = option.value === value; return <button key={option.value} type="button" role="radio" aria-checked={checked} disabled={disabled} tabIndex={checked ? 0 : -1}
        onClick={() => onChange(option.value)} onKeyDown={event => onKeyDown(event, index)}
        className={cn("flex max-sm:min-h-11 items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60", checked ? "border-primary bg-primary/5" : "border-border hover:bg-accent/40")}>
        {Icon ? <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", checked ? "text-primary" : "text-muted-foreground")} /> : <span aria-hidden className={cn("mt-1 size-3 shrink-0 rounded-full border-2", checked ? "border-primary bg-primary" : "border-muted-foreground/50")} />}
        <span className="min-w-0"><span className="block font-medium">{option.label}</span>{option.hint ? <span className="block text-xs text-muted-foreground">{option.hint}</span> : null}</span>
      </button>; })}
    </div>
  </div>;
}

export function SwitchField({ label, checked, onChange, help, disabled = false }: { label: string; checked: boolean; onChange: (checked: boolean) => void; help?: string; disabled?: boolean }) {
  return <label className="flex max-sm:min-h-11 min-w-0 items-center justify-between gap-4 rounded-xl border border-border px-3 py-2 text-sm">
    <span className="min-w-0"><span className="block font-medium">{label}</span>{help ? <span className="block text-xs text-muted-foreground">{help}</span> : null}</span>
    <Switch checked={checked} disabled={disabled} onCheckedChange={value => onChange(value === true)} />
  </label>;
}

export function FormSection({ title, description, collapsible = false, defaultOpen = false, children }: { title: string; description?: string; collapsible?: boolean; defaultOpen?: boolean; children: ReactNode }) {
  const grid = <div className="grid min-w-0 gap-4 pt-4 md:grid-cols-2">{children}</div>;
  if (collapsible) return <details open={defaultOpen || undefined} className="col-span-full min-w-0 rounded-xl border border-border px-4 pb-4">
    <summary className="-mx-4 min-h-8 max-sm:min-h-11 cursor-pointer list-none px-4 text-sm font-semibold content-center focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">{title}{description ? <span className="block text-xs font-normal text-muted-foreground">{description}</span> : null}</summary>{grid}
  </details>;
  return <section className="col-span-full min-w-0 border-t border-border pt-5 first:border-0 first:pt-0">
    <h3 className="text-sm font-semibold">{title}</h3>{description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}{grid}
  </section>;
}

export function FormFooter({ children }: { children: ReactNode }) {
  return <div className="sticky bottom-0 -mx-4 mt-2 flex flex-wrap items-center gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>{children}</div>;
}

export function TechnicalDetails({ rows, children }: { rows?: [string, string][]; children?: ReactNode }) {
  const t = useT().associationPage.ux;
  return <details className="text-xs text-muted-foreground">
    <summary className="min-h-11 cursor-pointer content-center focus-visible:outline-2 focus-visible:outline-ring md:min-h-8">{t.technical}</summary>
    <dl className="space-y-1 pb-2">{rows?.map(([label, value]) => <div key={label} className="flex flex-wrap gap-x-2"><dt className="shrink-0">{label}:</dt><dd className="break-all">{value}</dd></div>)}</dl>{children}
  </details>;
}

export type TableColumn<T> = { key: string; label: string; cell: (row: T) => ReactNode; width?: string; align?: "start" | "end"; primary?: boolean; hideBelowMd?: boolean };
/** One DOM for every width: a grid table from `md`, labelled stacked cards below. */
export function ResponsiveTable<T>({ columns, rows, rowKey, onRowClick, actions, empty, rowData }: {
  columns: TableColumn<T>[]; rows: T[]; rowKey: (row: T) => string; onRowClick?: (row: T) => void; actions?: (row: T) => ReactNode; empty: ReactNode; rowData?: (row: T) => Record<string, string>;
}) {
  const t = useT().associationPage.ux;
  if (rows.length === 0) return <>{empty}</>;
  const template = { "--association-columns": [...columns.map(column => column.width ?? "minmax(0,1fr)"), ...(actions ? ["auto"] : [])].join(" ") } as CSSProperties;
  const cellClass = (column: TableColumn<T>) => cn("min-w-0 text-sm", column.align === "end" ? "md:text-right" : "", column.hideBelowMd ? "hidden md:block" : "", "before:mr-2 before:text-xs before:text-muted-foreground before:content-[attr(data-label)] md:before:content-none");
  return <div role="table" className="overflow-hidden rounded-2xl border border-border bg-background" style={template}>
    <div role="row" className="hidden border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide md:grid md:grid-cols-[var(--association-columns)] md:gap-x-4">
      {columns.map(column => <div key={column.key} role="columnheader" className={column.align === "end" ? "text-right" : ""}>{column.label}</div>)}{actions ? <div role="columnheader" className="text-right">{t.actions}</div> : null}
    </div>
    <div className="divide-y divide-border">
      {rows.map(row => <div key={rowKey(row)} role="row" {...rowData?.(row)} className="grid gap-y-1 px-4 py-3 md:grid-cols-[var(--association-columns)] md:items-center md:gap-x-4">
        {columns.map(column => <div key={column.key} role="cell" data-label={column.label} className={cellClass(column)}>
          {column.primary && onRowClick ? <button type="button" className="min-h-11 text-left font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring md:min-h-0" onClick={() => onRowClick(row)}>{column.cell(row)}</button> : column.cell(row)}
        </div>)}
        {actions ? <div role="cell" className="flex flex-wrap items-center gap-2 pt-2 md:justify-end md:pt-0">{actions(row)}</div> : null}
      </div>)}
    </div>
  </div>;
}

export function associationDate(instant: string | null | undefined, style: "date" | "datetime" = "datetime"): string {
  if (!instant) return "";
  const date = new Date(instant);
  return style === "date" ? date.toLocaleDateString() : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
