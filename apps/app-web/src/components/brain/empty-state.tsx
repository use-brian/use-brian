"use client";

/**
 * Mounted Brain empty states: filter-mismatch feedback and pristine-brain
 * prompts that seed the shared floating chat through requestSurfaceChatSeed.
 * The unused legacy ingestion column and its private cards have been retired.
 */

import { useT } from "@/lib/i18n/client";
import { requestSurfaceChatSeed } from "@/lib/surface-chat-seed";
import { Building2, Sparkles, User, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

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
            requestSurfaceChatSeed({
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
            requestSurfaceChatSeed({
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
