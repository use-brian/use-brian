"use client";

/**
 * Shared composer footer controls: the deep-research toggle (left) + the
 * `standard | pro | max` model-tier picker (right). One presentational
 * component rendered by every doc surface that can open an `/api/chat`
 * turn — the floating dock (`floating-chat.tsx`), the page-comments band
 * (`page-comments.tsx`), and the in-thread reply composer
 * (`comment-thread-body.tsx`) — so the picker + toggle look and behave
 * identically wherever a turn is sent.
 *
 * The component is stateless: the owner holds the model / research state and
 * the research quota arrives over SSE. The floating chat keeps its historical
 * inline state (entangled with its stream handler) and only swaps in this
 * component; the comment surfaces use the co-located `useComposerControls`
 * hook — the same split `chat-model.ts` already documents for the model tier
 * ("the floating chat keeps its own inline copy; this hook is the shared seam
 * for new surfaces").
 *
 * Labels reuse the existing `chat.*` dictionary keys (the model + research
 * strings already live there), so this adds no new i18n.
 *
 * [COMP:app-web/composer-controls]
 */

import { useCallback, useState } from "react";
import { Bot, Sparkles, UserRound } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { useChatModelTier, type ModelTier } from "@/lib/chat-model";
import { webAppUrl } from "@/lib/primary-auth";

/** Remaining free-research quota the server reports on a research turn. */
export type ResearchQuota = { used: number; quota: number; isPaid: boolean };

/**
 * A normalized `research_quota` / `research_quota_exhausted` SSE event — the
 * shape {@link useComposerControls}'s `applyResearchQuotaEvent` folds into its
 * quota + exhausted state, shared by every composer that can arm research mode.
 */
export type ResearchQuotaEvent = {
  type: "research_quota" | "research_quota_exhausted";
  used?: number;
  quota?: number;
  isPaid?: boolean;
};

type Props = {
  /** Current model tier. */
  model: ModelTier;
  /** Pick a new tier. */
  onModelChange: (tier: ModelTier) => void;
  /** Workspace plan (`free` / `pro` / `max` / …) for tier gating, or null while
   *  it resolves. Over-tier items render disabled. */
  plan: string | null;
  /** Whether deep-research mode is armed for the next send. */
  researchMode: boolean;
  /** Flip research mode. The component owns the exhausted→upgrade redirect, so
   *  this only fires for a real toggle. */
  onResearchModeChange: (next: boolean) => void;
  /** Remaining free-research quota (from the `research_quota` SSE event), or
   *  null on paid plans / before the first research turn. */
  researchQuota: ResearchQuota | null;
  /** Free workspace has hit its lifetime research cap — the toggle becomes an
   *  upgrade affordance. */
  researchExhausted: boolean;
  /** Render the deep-research toggle. Defaults to `false`. Doc research
   *  mode now ships: a `mode:'research'` doc turn keeps its authoring tools
   *  (`renderPage`/`patchPage`/…) and web search, swaps in the research soul,
   *  and authors findings to the page — it never enters the tool-stripping
   *  coordinator path (the 2026-06-01 fix split "forbids research" from
   *  "forbids coordinator" server-side). So every doc surface opts in with
   *  `showResearch` — the floating dock, the Space→AI inline box, and all three
   *  comment composers. The default stays `false` because feed (`kind='app'`,
   *  `appType='distribution'`) assistants still have research force-disabled. */
  showResearch?: boolean;
  /** Which way the model dropdown opens. Bottom-anchored composers (the dock,
   *  the thread reply) open `top`; the page-comments band (near the page top)
   *  opens `bottom`. */
  selectSide?: "top" | "bottom";
  /** Comment surfaces only: whether the assistant should reply to this turn.
   *  When `false` the comment is posted for teammates with no AI reply, and the
   *  research + model controls (which only shape an AI turn) are disabled.
   *  Undefined on the floating chat — the AI always answers there, so no toggle
   *  renders. */
  aiReply?: boolean;
  /** Flip the AI-reply toggle. Presence of this handler is what renders the
   *  toggle — so the floating chat (which omits it) never shows it. */
  onAiReplyChange?: (next: boolean) => void;
  /** Row layout override (margin) for the host composer. */
  className?: string;
};

/**
 * The picker + toggle. Pure presentation — every prop is owned by the caller.
 */
export function ComposerControls({
  model,
  onModelChange,
  plan,
  researchMode,
  onResearchModeChange,
  researchQuota,
  researchExhausted,
  showResearch = false,
  selectSide = "top",
  aiReply,
  onAiReplyChange,
  className,
}: Props) {
  const t = useT().chat;
  const tc = useT().comments;
  // The AI-reply toggle shows only where a host wires it (the comment
  // composers). When the AI won't reply, the research + model controls — which
  // only shape an AI turn — are disabled so they don't imply otherwise.
  const showAiToggle = !!onAiReplyChange;
  const aiOn = aiReply !== false;
  const aiTurnDisabled = showAiToggle && !aiOn;
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {showAiToggle ? (
        // Subtle icon-only toggle (label rides the tooltip + aria-label). Both
        // glyphs are horizontally symmetric — `Bot` and the single-figure
        // `UserRound` — so the icon reads as centered in the square button
        // (lucide's two-figure `Users` is optically left-weighted and looked
        // off-center). `justify-center` pins it dead-center either way.
        <button
          type="button"
          onClick={() => onAiReplyChange?.(!aiOn)}
          aria-pressed={aiOn}
          aria-label={aiOn ? tc.aiReply : tc.aiReplyOff}
          title={aiOn ? tc.aiReplyHintOn : tc.aiReplyHintOff}
          className={cn(
            "inline-flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors",
            aiOn
              ? "bg-primary/15 text-primary hover:bg-primary/20"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {aiOn ? (
            <Bot className="size-4" aria-hidden />
          ) : (
            <UserRound className="size-4" aria-hidden />
          )}
        </button>
      ) : null}
      {showResearch ? (
        <button
          type="button"
          disabled={aiTurnDisabled}
          onClick={() => {
            if (researchExhausted) {
              // `/plans` lives on the marketing origin (apps/web) — deep-link
              // via webAppUrl(), same pattern as billing-section.tsx.
              if (typeof window !== "undefined") window.location.href = `${webAppUrl()}/plans`;
              return;
            }
            onResearchModeChange(!researchMode);
          }}
          aria-pressed={researchMode}
          title={researchExhausted ? t.researchHintExhausted : t.researchHint}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
            researchExhausted
              ? "bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
              : researchMode
                ? "bg-primary/15 text-primary hover:bg-primary/20"
                : "text-muted-foreground hover:bg-muted hover:text-primary",
          )}
        >
          <Sparkles className="size-3.5" aria-hidden />
          <span>{t.research}</span>
          {researchMode && researchQuota && !researchQuota.isPaid ? (
            <span className="ml-0.5 text-[10.5px] tabular-nums opacity-70">
              {Math.max(0, researchQuota.quota - researchQuota.used)}/{researchQuota.quota}
            </span>
          ) : null}
        </button>
      ) : null}
      <div className="flex-1" />
      <Select
        value={model}
        onValueChange={(v) => { if (v) onModelChange(v as ModelTier); }}
        disabled={aiTurnDisabled}
      >
        <SelectTrigger
          size="sm"
          aria-label={t.modelLabel}
          disabled={aiTurnDisabled}
          className="gap-1.5 border-transparent bg-muted/60 text-xs hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
        >
          <span className="font-medium">
            {model === "pro" ? t.modelPro : model === "max" ? t.modelMax : t.modelStandard}
          </span>
        </SelectTrigger>
        <SelectContent side={selectSide} align="end" alignItemWithTrigger={false} className="w-auto min-w-56">
          <SelectItem value="standard">
            <div className="flex flex-col gap-0.5 py-0.5">
              <span className="text-sm font-medium">{t.modelStandard}</span>
              <span className="text-[11px] text-muted-foreground">{t.modelStandardDesc}</span>
            </div>
          </SelectItem>
          <SelectItem value="pro" disabled={plan === "free"}>
            <div className="flex flex-col gap-0.5 py-0.5">
              <span className="text-sm font-medium">{t.modelPro}</span>
              <span className="text-[11px] text-muted-foreground">{t.modelProDesc}</span>
            </div>
          </SelectItem>
          <SelectItem value="max" disabled={plan === "free" || plan === "pro"}>
            <div className="flex flex-col gap-0.5 py-0.5">
              <span className="text-sm font-medium">{t.modelMax}</span>
              <span className="text-[11px] text-muted-foreground">{t.modelMaxDesc}</span>
            </div>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export type ComposerControlsState = {
  model: ModelTier;
  setModel: (tier: ModelTier) => void;
  /** Workspace plan once resolved (`free` / `pro` / `max` / …), else null. */
  plan: string | null;
  researchMode: boolean;
  setResearchMode: (next: boolean) => void;
  researchQuota: ResearchQuota | null;
  researchExhausted: boolean;
  /** Fold a `research_quota` / `research_quota_exhausted` SSE event into the
   *  quota + exhausted state — identical handling to the floating chat. Call it
   *  from a composer's inline SSE loop (`comment-thread-body`'s `sendReply`). */
  applyResearchQuotaEvent: (evt: ResearchQuotaEvent) => void;
};

/**
 * Composer control state for the doc surfaces that open an `/api/chat` turn
 * but DON'T carry the floating chat's inline state — the page-comments band and
 * the in-thread reply composer. Bundles the shared model-tier hook
 * (`useChatModelTier`, so the `doc-chat-model` choice carries across every
 * surface) with deep-research mode + the free-research quota the server reports
 * over SSE.
 */
export function useComposerControls(workspaceId: string): ComposerControlsState {
  const { model, setModel, plan } = useChatModelTier(workspaceId, "standard");
  const [researchMode, setResearchMode] = useState(false);
  const [researchQuota, setResearchQuota] = useState<ResearchQuota | null>(null);
  const [researchExhausted, setResearchExhausted] = useState(false);

  const applyResearchQuotaEvent = useCallback((evt: ResearchQuotaEvent) => {
    if (evt.type === "research_quota_exhausted") {
      // Free workspace hit its lifetime research cap — disarm + reflect it.
      setResearchExhausted(true);
      setResearchMode(false);
      setResearchQuota({ used: evt.used ?? 0, quota: evt.quota ?? 0, isPaid: false });
    } else {
      setResearchQuota({
        used: evt.used ?? 0,
        quota: evt.quota ?? 0,
        isPaid: evt.isPaid === true,
      });
    }
  }, []);

  return {
    model,
    setModel,
    plan,
    researchMode,
    setResearchMode,
    researchQuota,
    researchExhausted,
    applyResearchQuotaEvent,
  };
}
