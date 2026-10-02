"use client";

/**
 * Shared Organization visuals: tinted avatars, avatar stacks, stat tiles,
 * clearance pills and bars, one-line notes, the "How this works" disclosure
 * and a segmented panel switch. Callers pass every visible string, so this
 * module holds no copy.
 *
 * Spec: docs/architecture/features/organization-chart.md → "Visual presentation".
 * [COMP:app-web/organization-visuals]
 */
import { useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Bot, ChevronRight, Info, type LucideIcon } from "lucide-react";
import { getInitials } from "@/lib/user";
import { cn } from "@/lib/utils";

/** The doc colour palette (`--doc-color-*` / `--doc-bg-*`), light and dark aware. */
export const ORG_TONES = ["blue", "green", "purple", "orange", "pink", "brown", "yellow", "red", "gray"] as const;
export type OrgTone = (typeof ORG_TONES)[number];
export type Clearance = "public" | "internal" | "confidential";

const CLEARANCE_TONE: Record<Clearance, OrgTone> = { public: "green", internal: "blue", confidential: "orange" };
const CLEARANCE_ORDER: Clearance[] = ["confidential", "internal", "public"];

/** A stable tone for an id or name; gray is reserved for neutral chrome. */
export function toneFor(seed: string): OrgTone {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return ORG_TONES[Math.abs(hash) % (ORG_TONES.length - 1)];
}

/** A department's own colour when it names a palette tone, otherwise a stable one. */
export function departmentTone(color: string | null | undefined, id: string): OrgTone {
  const named = color?.trim().toLowerCase();
  return (ORG_TONES as readonly string[]).includes(named ?? "") ? (named as OrgTone) : toneFor(id);
}

const toneText = (tone: OrgTone): CSSProperties => ({ color: `var(--doc-color-${tone})` });
export const toneFill = (tone: OrgTone): CSSProperties => ({ color: `var(--doc-color-${tone})`, backgroundColor: `var(--doc-bg-${tone})` });
export const toneSolid = (tone: OrgTone): CSSProperties => ({ backgroundColor: `var(--doc-color-${tone})` });

export function OrgAvatar({ name, kind = "member", seed, size = 28, className }: {
  name: string; kind?: "member" | "assistant"; seed?: string; size?: number; className?: string;
}) {
  const tone = toneFor(seed ?? name);
  const box = { width: size, height: size, ...toneFill(tone) };
  if (kind === "assistant") {
    return <span aria-hidden style={box} className={cn("grid shrink-0 place-items-center rounded-md ring-2 ring-background", className)}>
      <Bot style={{ width: size * 0.55, height: size * 0.55 }} />
    </span>;
  }
  return <span aria-hidden style={{ ...box, fontSize: Math.max(9, Math.round(size * 0.38)) }}
    className={cn("grid shrink-0 place-items-center rounded-full font-semibold ring-2 ring-background", className)}>
    {getInitials(name || "?")}
  </span>;
}

/** Overlapping avatars with a `+N` overflow. `label` is the accessible summary. */
export function AvatarStack({ items, label, max = 5, size = 24 }: {
  items: Array<{ id: string; name: string; kind: "member" | "assistant" }>; label: string; max?: number; size?: number;
}) {
  const shown = items.slice(0, max);
  const extra = items.length - shown.length;
  return <span role="img" aria-label={label} title={items.map(item => item.name).join(", ")} className="flex items-center">
    {shown.map((item, index) => <OrgAvatar key={`${item.kind}:${item.id}`} name={item.name} kind={item.kind} seed={item.id} size={size} className={index ? "-ml-1.5" : undefined} />)}
    {extra > 0 ? <span aria-hidden style={{ height: size, minWidth: size }}
      className="-ml-1.5 grid place-items-center rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground ring-2 ring-background">+{extra}</span> : null}
  </span>;
}

export function StatStrip({ children, label }: { children: ReactNode; label: string }) {
  return <dl aria-label={label} className="grid grid-cols-2 gap-2 lg:grid-cols-4">{children}</dl>;
}

export function StatTile({ icon: Icon, label, value, hint, tone = "gray" }: {
  icon: LucideIcon; label: string; value: ReactNode; hint?: ReactNode; tone?: OrgTone;
}) {
  return <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
    <span aria-hidden style={toneFill(tone)} className="grid size-8 shrink-0 place-items-center rounded-lg"><Icon className="size-4" /></span>
    <div className="min-w-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-base font-semibold tabular-nums leading-6">{value}</span>
        {hint ? <span className="truncate text-xs text-muted-foreground">{hint}</span> : null}
      </dd>
    </div>
  </div>;
}

export function Chip({ children, tone, icon: Icon, className, title }: {
  children: ReactNode; tone?: OrgTone; icon?: LucideIcon; className?: string; title?: string;
}) {
  return <span title={title} style={tone ? toneFill(tone) : undefined}
    className={cn("inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", tone ? null : "bg-muted text-muted-foreground", className)}>
    {Icon ? <Icon aria-hidden className="size-3 shrink-0" /> : null}<span className="truncate">{children}</span>
  </span>;
}

export function ClearancePill({ clearance, label }: { clearance: Clearance; label: string }) {
  return <Chip tone={CLEARANCE_TONE[clearance]}>{label}</Chip>;
}

/** Stacked bar of readers per clearance, with a counted legend. */
export function ClearanceBar({ counts, labels, legend = true }: {
  counts: Record<Clearance, number>; labels: Record<Clearance, string>; legend?: boolean;
}) {
  const total = CLEARANCE_ORDER.reduce((sum, level) => sum + counts[level], 0);
  const summary = CLEARANCE_ORDER.filter(level => counts[level]).map(level => `${counts[level]} ${labels[level]}`).join(", ");
  return <div className="min-w-0 space-y-1.5">
    <div role="img" aria-label={summary || "0"} className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
      {total ? CLEARANCE_ORDER.map(level => counts[level] ? <span key={level} style={{ ...toneSolid(CLEARANCE_TONE[level]), flexGrow: counts[level] }} className="h-full first:rounded-l-full last:rounded-r-full" /> : null) : null}
    </div>
    {legend ? <ul aria-hidden className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
      {CLEARANCE_ORDER.map(level => <li key={level} className="inline-flex items-center gap-1">
        <span style={toneSolid(CLEARANCE_TONE[level])} className="size-1.5 rounded-full" />{labels[level]} <span className="tabular-nums">{counts[level]}</span>
      </li>)}
    </ul> : null}
  </div>;
}

/** A one-line explanation, muted, with no box around it. */
export function InfoNote({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground", className)}>
    <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0">{children}</span>
  </p>;
}

/** Longer policy copy, collapsed by default behind a one-line summary. A soft
 * fill, never a border, so it may sit inside a card (web-ui.md → "One frame per region"). */
export function HowItWorks({ summary, children, tone }: { summary: ReactNode; children: ReactNode; tone?: OrgTone }) {
  return <details className="group rounded-lg bg-muted/40">
    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground hover:text-foreground max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
      <Info aria-hidden className="size-3.5 shrink-0" style={tone ? toneText(tone) : undefined} />
      <span className="min-w-0 flex-1">{summary}</span>
      <ChevronRight aria-hidden className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
    </summary>
    <div className="space-y-2 px-3 pb-2.5 pt-0.5 text-[13px] leading-relaxed text-muted-foreground">{children}</div>
  </details>;
}

/** `bare` drops the dashed frame for an empty state that already sits inside a card. */
export function EmptyState({ icon: Icon, children, action, bare = false }: { icon: LucideIcon; children: ReactNode; action?: ReactNode; bare?: boolean }) {
  return <div className={cn("flex flex-col items-center gap-2 px-4 text-center", bare ? "py-4" : "rounded-xl border border-dashed border-border py-6")}>
    <Icon aria-hidden className="size-5 text-muted-foreground/60" />
    <p className="max-w-sm text-sm text-muted-foreground">{children}</p>
    {action}
  </div>;
}

/** Neutral segmented switch over sibling panels (tablist semantics, arrow keys). */
export function SegmentedTabs<T extends string>({ value, onChange, items, label, idPrefix }: {
  value: T; onChange: (value: T) => void; label: string; idPrefix?: string;
  items: Array<{ value: T; label: string; icon?: LucideIcon; count?: number }>;
}) {
  const fallback = useId();
  const prefix = idPrefix ?? fallback;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = items.findIndex(item => item.value === value);
    const next = (index + (event.key === "ArrowRight" ? 1 : items.length - 1)) % items.length;
    onChange(items[next].value);
    refs.current[next]?.focus();
  };
  return <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5">
    {items.map((item, index) => {
      const selected = item.value === value;
      const Icon = item.icon;
      return <button key={item.value} ref={el => { refs.current[index] = el; }} type="button" role="tab" id={`${prefix}-tab-${item.value}`}
        aria-selected={selected} aria-controls={`${prefix}-panel-${item.value}`} tabIndex={selected ? 0 : -1} onClick={() => onChange(item.value)}
        className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors max-sm:min-h-11",
          selected ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
        {Icon ? <Icon aria-hidden className="size-3.5 shrink-0" /> : null}{item.label}
        {item.count !== undefined ? <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{item.count}</span> : null}
      </button>;
    })}
  </div>;
}

export function tabPanelProps(prefix: string, value: string) {
  return { role: "tabpanel" as const, id: `${prefix}-panel-${value}`, "aria-labelledby": `${prefix}-tab-${value}` };
}
