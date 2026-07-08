"use client";

/**
 * Brain empty-state helpers (app-web).
 *
 * Ported from `apps/web/src/components/brain/empty-state.tsx` as part of
 * the brain surface migration
 * (docs/architecture/features/doc.md §5a). Exports:
 *   - `<EmptyState />` — "Nothing matches" filter-mismatch message.
 *   - `<PristineBrainNudge />` — the pristine-brain hero. Its two CTA
 *     tiles seed the shared assistant chat dock via `requestBrainChatSeed()`
 *     (NOT doc's page-editing chat-seed — see surface-chat-seed.ts for why).
 *   - `<IngestionNudge />` — the right-column tabbed ingest/consume nudge.
 *
 * app-web ADAPTATIONS (flagged, not silent):
 *   - The "Tell me about you" / "Research my company" tiles use
 *     `requestBrainChatSeed` (an alias over the shared surface-chat seed
 *     bus), which the one `FloatingChat` dock — mounted once by
 *     `WorkspaceChrome` across every surface — handles (its surface-seed
 *     listener is no longer origin-gated). apps/web routes these into the
 *     app-chrome FloatingChat; here the same one dock catches the seed.
 *   - Studio CTAs (Knowledge / Ingest rules / Connectors / Channels /
 *     Programmatic access / Mini apps) route IN-APP to
 *     `/w/[id]/studio/<section>` — app-web hosts Studio since the
 *     single-app consolidation ("#" while the workspace id resolves).
 *   - The Workflow CTA routes IN-APP to `/w/[id]/workflow`.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { useWorkspaces } from "@/contexts/workspace-context";
import { createBrainKey, BRAIN_MCP_URL, type CreatedBrainKey } from "@/lib/api/brain-keys";
import { requestBrainChatSeed } from "@/lib/surface-chat-seed";
import {
  Bot,
  Building2,
  Check,
  Code2,
  GitBranch,
  LayoutGrid,
  Loader2,
  MessageSquareText,
  Radio,
  Sparkles,
  Terminal,
  User,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "primary" | "blue" | "emerald" | "violet" | "amber";

// Per-card visual tone. The gradient + icon + accent + border all share
// the same hue so each card reads as one cohesive "channel" of ingest
// path. Border is inline (not `ring`) so it renders fully even when an
// ancestor sets overflow-hidden or overflow-y-auto (which silently
// computes overflow-x: hidden) — `ring-*` would get clipped at those
// edges, inline borders sit inside the element bounds and always render.
const TONE: Record<Tone, { card: string; icon: string; accent: string }> = {
  primary: {
    card: "bg-gradient-to-br from-primary/[0.10] via-card/60 to-card border border-primary/25 hover:border-primary/45 transition-colors",
    icon: "bg-primary/15 text-primary",
    accent: "text-primary",
  },
  blue: {
    card: "bg-gradient-to-br from-sky-500/[0.08] via-card/60 to-card border border-sky-500/25 hover:border-sky-500/45 transition-colors",
    icon: "bg-sky-500/15 text-sky-500 dark:text-sky-400",
    accent: "text-sky-500 dark:text-sky-400",
  },
  emerald: {
    card: "bg-gradient-to-br from-emerald-500/[0.08] via-card/60 to-card border border-emerald-500/25 hover:border-emerald-500/45 transition-colors",
    icon: "bg-emerald-500/15 text-emerald-500 dark:text-emerald-400",
    accent: "text-emerald-500 dark:text-emerald-400",
  },
  violet: {
    card: "bg-gradient-to-br from-violet-500/[0.08] via-card/60 to-card border border-violet-500/25 hover:border-violet-500/45 transition-colors",
    icon: "bg-violet-500/15 text-violet-500 dark:text-violet-400",
    accent: "text-violet-500 dark:text-violet-400",
  },
  amber: {
    card: "bg-gradient-to-br from-amber-500/[0.08] via-card/60 to-card border border-amber-500/25 hover:border-amber-500/45 transition-colors",
    icon: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    accent: "text-amber-600 dark:text-amber-400",
  },
};

export function EmptyState() {
  const t = useT();
  const copy = t.brainPage.emptyResults;
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center p-6 gap-2">
      <div className="font-medium text-base">{copy.title}</div>
      <p className="text-sm text-muted-foreground max-w-md">{copy.body}</p>
    </div>
  );
}

// ── Pristine-brain nudge ──────────────────────────────────────
//
// Shown in the main column of the brain card when the workspace has
// zero brain rows AND the user hasn't engaged with any filter. Two tiles
// hand the user into the brain chat panel, each with a seeded prompt that
// flips research mode on so the assistant runs the brain-ingestion
// pipeline (max-tier model + coordinator).

export function PristineBrainNudge() {
  const t = useT();
  const copy = t.brainPage.pristineNudge;
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center px-6 py-8 gap-6">
      <div className="flex flex-col items-center gap-3 max-w-md">
        <div className="w-11 h-11 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
          <Sparkles className="w-[18px] h-[18px]" strokeWidth={1.75} />
        </div>
        <h2 className="text-base font-semibold tracking-tight">{copy.title}</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">{copy.body}</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-xl">
        <NudgeTile
          tone="primary"
          icon={User}
          title={copy.self.title}
          body={copy.self.body}
          cta={copy.self.cta}
          onClick={() =>
            requestBrainChatSeed({
              prefill: copy.self.prefill,
            })
          }
        />
        <NudgeTile
          tone="blue"
          icon={Building2}
          title={copy.company.title}
          body={copy.company.body}
          cta={copy.company.cta}
          onClick={() =>
            requestBrainChatSeed({
              prefill: copy.company.prefill,
              deferResearch: true,
            })
          }
        />
      </div>
      <p className="text-[11.5px] text-muted-foreground/70">{copy.hint}</p>
    </div>
  );
}

const NUDGE_TILE_TONE: Record<"primary" | "blue", { card: string; icon: string; accent: string }> = {
  primary: {
    card: "bg-gradient-to-br from-primary/[0.08] via-card/60 to-card border-primary/30 hover:border-primary/55",
    icon: "bg-primary/15 text-primary",
    accent: "text-primary",
  },
  blue: {
    card: "bg-gradient-to-br from-sky-500/[0.08] via-card/60 to-card border-sky-500/30 hover:border-sky-500/55",
    icon: "bg-sky-500/15 text-sky-500 dark:text-sky-400",
    accent: "text-sky-500 dark:text-sky-400",
  },
};

function NudgeTile({
  tone,
  icon: Icon,
  title,
  body,
  cta,
  onClick,
}: {
  tone: keyof typeof NUDGE_TILE_TONE;
  icon: LucideIcon;
  title: string;
  body: string;
  cta: string;
  onClick: () => void;
}) {
  const styles = NUDGE_TILE_TONE[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group text-left rounded-2xl border px-4 py-4 flex flex-col gap-3 transition-colors",
        styles.card,
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center shrink-0", styles.icon)}>
          <Icon className="w-[16px] h-[16px]" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold tracking-tight leading-tight">{title}</div>
          <p className="text-[12px] text-muted-foreground mt-1 leading-snug">{body}</p>
        </div>
      </div>
      <span
        className={cn(
          "text-[12px] font-medium inline-flex items-center gap-1 transition-transform group-hover:translate-x-0.5",
          styles.accent,
        )}
      >
        {cta} →
      </span>
    </button>
  );
}

// ── Static card primitive ─────────────────────────────────────

function StaticCard({
  tone,
  icon: Icon,
  title,
  body,
  children,
  className,
}: {
  tone: Tone;
  icon: LucideIcon;
  title: string;
  body: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const styles = TONE[tone];
  return (
    <div
      className={cn(
        "rounded-2xl px-5 py-4 flex flex-col gap-3",
        styles.card,
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center shrink-0", styles.icon)}>
          <Icon className="w-[16px] h-[16px]" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-semibold tracking-tight leading-tight">{title}</h3>
          <p className="text-[12px] text-muted-foreground mt-1 leading-snug">{body}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

// Tone → CTA button border tint. The CTA inherits the parent card's
// accent color so the redirect button reads as part of the card, not a
// generic neutral pill. Kept as a flat map (vs. dynamic class strings)
// so Tailwind's static extractor picks every variant up at build time.
const CTA_BORDER: Record<Tone, string> = {
  primary: "border-primary/30 hover:border-primary/50 hover:bg-primary/[0.05]",
  blue: "border-sky-500/30 hover:border-sky-500/50 hover:bg-sky-500/[0.05]",
  emerald: "border-emerald-500/30 hover:border-emerald-500/50 hover:bg-emerald-500/[0.05]",
  violet: "border-violet-500/30 hover:border-violet-500/50 hover:bg-violet-500/[0.05]",
  amber: "border-amber-500/30 hover:border-amber-500/50 hover:bg-amber-500/[0.05]",
};

/**
 * CTA button — an in-app Next `<Link>` styled to read as part of the
 * parent card (the accent + border tint share the card's tone).
 */
function CtaButton({
  tone,
  href,
  label,
}: {
  tone: Tone;
  href: string;
  label: string;
}) {
  const styles = TONE[tone];
  const className = cn(
    "inline-flex items-center justify-center gap-1.5 text-[12px] font-medium rounded-lg px-3 py-2 transition-colors w-full",
    "bg-background/70 border",
    CTA_BORDER[tone],
    styles.accent,
  );
  return (
    <Link href={href} className={className}>
      {label} →
    </Link>
  );
}

// ── Ingestion nudge (reused on the data view) ─────────────────

const NUDGE_MODE_STORAGE = "brain-nudge-mode-v1";
type NudgeMode = "ingest" | "consume";

function loadNudgeMode(): NudgeMode {
  if (typeof window === "undefined") return "ingest";
  try {
    const v = window.localStorage.getItem(NUDGE_MODE_STORAGE);
    return v === "consume" ? "consume" : "ingest";
  } catch {
    return "ingest";
  }
}

/**
 * Two-tab nudge column rendered on the right of the brain page (1/3
 * width on lg+, full-width stacked on smaller).
 *
 * - **Ingest** (default): MCP brain-key gen, Sync Knowledge Base CTA,
 *   Connect daily-driver tools CTA. The "feed the brain" lane.
 * - **Consume**: same MCP brain-key (read-side), Connect to channel,
 *   Build with Assistant API, Mini apps. The "use the brain" lane.
 *
 * The active tab persists in localStorage so the user's chosen lens
 * survives refreshes / route transitions.
 */
export function IngestionNudge({ className }: { className?: string }) {
  const t = useT();
  const copy = t.brainPage.emptyState.nudge;
  const [mode, setMode] = useState<NudgeMode>(loadNudgeMode);
  // Direction of the most recent mode switch — drives whether the new
  // card list slides in from the left or the right so the motion
  // matches the thumb's travel direction (Ingest = left tab, Consume
  // = right tab).
  const [direction, setDirection] = useState<"left" | "right" | "none">("none");

  function changeMode(next: NudgeMode) {
    if (next === mode) return;
    setDirection(next === "consume" ? "right" : "left");
    setMode(next);
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(NUDGE_MODE_STORAGE, mode);
    } catch {
      /* non-fatal */
    }
  }, [mode]);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Full-width segmented control. The active "thumb" is a single
          absolutely-positioned element that slides via translate-x. */}
      <div className="relative grid grid-cols-2 p-0.5 rounded-lg bg-muted/60 border border-border/60">
        <div
          aria-hidden
          className={cn(
            "absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-2px)] rounded-md bg-background shadow-sm transition-transform duration-250 ease-out z-0",
            mode === "consume" && "translate-x-full",
          )}
        />
        <NudgeTab active={mode === "ingest"} onClick={() => changeMode("ingest")}>
          {copy.ingestTab}
        </NudgeTab>
        <NudgeTab active={mode === "consume"} onClick={() => changeMode("consume")}>
          {copy.consumeTab}
        </NudgeTab>
      </div>
      <div className="overflow-hidden">
        <div
          key={mode}
          className={cn(
            "flex flex-col gap-3 animate-in fade-in duration-250 ease-out",
            direction === "right" && "slide-in-from-right-12",
            direction === "left" && "slide-in-from-left-12",
          )}
        >
          {mode === "ingest" ? (
            <>
              <McpCard />
              <ConnectionsCard />
              <IngestionCard />
              <KnowledgeBaseCard />
            </>
          ) : (
            <>
              <McpCard />
              <TalkToAssistantsCard />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NudgeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative z-10 px-3 py-1 text-[12px] font-medium rounded-md transition-colors",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// ── MCP card (static, compact) ────────────────────────────────

function McpCard() {
  const t = useT();
  const copy = t.brainPage.emptyState.cards.mcp;
  const { activeId } = useWorkspaces();
  const [created, setCreated] = useState<CreatedBrainKey | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleGenerate() {
    if (!activeId || creating) return;
    setCreating(true);
    setError(null);
    try {
      const key = await createBrainKey(activeId, {
        name: copy.keyName,
        scope: "read_write",
      });
      setCreated(key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    if (!created) return;
    try {
      const snippet = `${BRAIN_MCP_URL} | Authorization: Bearer ${created.key}`;
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied — no-op */
    }
  }

  return (
    <StaticCard tone="primary" icon={Terminal} title={copy.title} body={copy.body}>
      {!created ? (
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!activeId || creating}
          className="inline-flex items-center justify-center gap-1.5 text-[12px] font-medium bg-primary text-primary-foreground px-3 py-2 rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors w-full"
        >
          {creating ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {copy.keyGenerating}
            </>
          ) : (
            copy.keyGenerateCta
          )}
        </button>
      ) : (
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center justify-center gap-1.5 text-[12px] font-medium bg-primary text-primary-foreground px-3 py-2 rounded-lg hover:bg-primary/90 transition-colors w-full"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5" />
              {copy.copyDone}
            </>
          ) : (
            copy.copyCta
          )}
        </button>
      )}
      {error && <div className="text-[10.5px] text-destructive">{error}</div>}
      {created && (
        <div className="text-[10.5px] text-muted-foreground/80 leading-snug">
          {copy.keyShowOnceWarning}
        </div>
      )}
    </StaticCard>
  );
}

// ── Knowledge Base card (CTA only) ────────────────────────────

function KnowledgeBaseCard() {
  const t = useT();
  const copy = t.brainPage.emptyState.cards.knowledgeBase;
  const { activeId } = useWorkspaces();
  return (
    <StaticCard tone="emerald" icon={GitBranch} title={copy.title} body={copy.body}>
      <CtaButton tone="emerald" href={activeId ? `/w/${activeId}/studio/knowledge` : "#"} label={copy.cta} />
    </StaticCard>
  );
}

// ── Ingestion card — events pipeline (sibling of Knowledge) ───

function IngestionCard() {
  const t = useT();
  const copy = t.brainPage.emptyState.cards.ingestion;
  const { activeId } = useWorkspaces();
  return (
    <StaticCard tone="violet" icon={Workflow} title={copy.title} body={copy.body}>
      <CtaButton tone="violet" href={activeId ? `/w/${activeId}/studio/ingest-rules` : "#"} label={copy.cta} />
    </StaticCard>
  );
}

// ── Connections card (CTA only) ───────────────────────────────

function ConnectionsCard() {
  const t = useT();
  const copy = t.brainPage.emptyState.cards.connectors;
  const { activeId } = useWorkspaces();
  return (
    <StaticCard tone="amber" icon={MessageSquareText} title={copy.title} body={copy.body}>
      <CtaButton tone="amber" href={activeId ? `/w/${activeId}/studio/connectors` : "#"} label={copy.cta} />
    </StaticCard>
  );
}

// ── Talk-to-assistants — compressed multi-row consume hub ─────

const SUB_ROW_TONES: Record<"violet" | "blue" | "emerald" | "amber", { icon: string; arrow: string }> = {
  violet: { icon: "bg-violet-500/15 text-violet-500 dark:text-violet-400", arrow: "text-violet-500 dark:text-violet-400" },
  blue: { icon: "bg-sky-500/15 text-sky-500 dark:text-sky-400", arrow: "text-sky-500 dark:text-sky-400" },
  emerald: { icon: "bg-emerald-500/15 text-emerald-500 dark:text-emerald-400", arrow: "text-emerald-500 dark:text-emerald-400" },
  amber: { icon: "bg-amber-500/15 text-amber-600 dark:text-amber-400", arrow: "text-amber-600 dark:text-amber-400" },
};

/**
 * Consume sub-row — an in-app Next `<Link>` row (every destination lives
 * under `/w/[id]/...` in app-web).
 */
function SubRow({
  icon: Icon,
  tone,
  href,
  title,
  body,
}: {
  icon: LucideIcon;
  tone: keyof typeof SUB_ROW_TONES;
  href: string;
  title: string;
  body: string;
}) {
  const styles = SUB_ROW_TONES[tone];
  return (
    <Link
      href={href}
      className="group flex items-center gap-2.5 px-2 py-2 rounded-lg border border-transparent hover:border-border/60 hover:bg-background/60 transition-colors"
    >
      <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0", styles.icon)}>
        <Icon className="w-[14px] h-[14px]" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium leading-tight">{title}</div>
        <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">{body}</div>
      </div>
      <div className={cn("text-[13px] shrink-0 opacity-60 group-hover:opacity-100 transition-opacity", styles.arrow)}>→</div>
    </Link>
  );
}

function TalkToAssistantsCard() {
  const t = useT();
  const copy = t.brainPage.emptyState.cards.talkToAssistants;
  const { activeId } = useWorkspaces();
  const styles = TONE.primary;
  return (
    <div className={cn("rounded-2xl px-5 py-4 flex flex-col gap-3", styles.card)}>
      <div className="flex items-start gap-3">
        <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center shrink-0", styles.icon)}>
          <Bot className="w-[16px] h-[16px]" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-semibold tracking-tight leading-tight">{copy.title}</h3>
          <p className="text-[12px] text-muted-foreground mt-1 leading-snug">{copy.body}</p>
        </div>
      </div>
      <div className="flex flex-col gap-0.5 -mx-1">
        <SubRow tone="violet" icon={Radio} href={activeId ? `/w/${activeId}/studio/channels` : "#"} title={copy.channel.title} body={copy.channel.body} />
        <SubRow tone="blue" icon={Code2} href={activeId ? `/w/${activeId}/studio/programmatic-access` : "#"} title={copy.api.title} body={copy.api.body} />
        <SubRow tone="emerald" icon={LayoutGrid} href={activeId ? `/w/${activeId}/studio/mini-apps` : "#"} title={copy.miniApp.title} body={copy.miniApp.body} />
        <SubRow tone="amber" icon={Workflow} href={activeId ? `/w/${activeId}/workflow` : "#"} title={copy.workflow.title} body={copy.workflow.body} />
      </div>
    </div>
  );
}
