"use client";

/**
 * Shared composer footer controls: the optional AI-reply toggle + the
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
 * Tier labels reuse `chat.*` dictionary keys. Hosts can supply a localized
 * `pickerLabel` (Effort in Chat) without changing tier state or admission.
 *
 * [COMP:app-web/composer-controls]
 */

import { useCallback, useState } from "react";
import { Bot, UserRound } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { useChatModelTier, type ModelTier } from "@/lib/chat-model";
import { deploymentCapabilities } from "@/lib/edition";
import { modelTierPlanGateApplies, planGateApplies } from "@/lib/plan-gate";

/** Remaining free-research quota the server reports on a research turn. */
type ResearchQuota = { used: number; quota: number; isPaid: boolean };

/**
 * A normalized `research_quota` / `research_quota_exhausted` SSE event — the
 * shape {@link useComposerControls}'s `applyResearchQuotaEvent` folds into its
 * quota + exhausted state, shared by every composer that can arm research mode.
 */
type ResearchQuotaEvent = {
  type: "research_quota" | "research_quota_exhausted";
  used?: number;
  quota?: number;
  isPaid?: boolean;
};

type Props = {
  /** Current model tier. */
  model: ModelTier;
  /** Surface-specific accessible label (Chat presents the curated tiers as effort). */
  pickerLabel?: string;
  /** Pick a new tier. */
  onModelChange: (tier: ModelTier) => void;
  /** Workspace plan (`free` / `pro` / `max` / …) for tier gating, or null while
   *  it resolves. Over-tier items render disabled. */
  plan: string | null;
  /** @deprecated Legacy seed compatibility. Research is assessed automatically. */
  researchMode?: boolean;
  /** @deprecated No manual Research control is rendered. */
  onResearchModeChange?: (next: boolean) => void;
  /** @deprecated Quota events are handled by the conversation surface. */
  researchQuota?: ResearchQuota | null;
  /** @deprecated Quota events are handled by the conversation surface. */
  researchExhausted?: boolean;
  /** @deprecated Ignored. Research is assessed automatically. */
  showResearch?: boolean;
  /** Which way the model dropdown opens. Bottom-anchored composers (the dock,
   *  the thread reply) open `top`; the page-comments band (near the page top)
   *  opens `bottom`. */
  selectSide?: "top" | "bottom";
  /** Comment surfaces only: whether the assistant should reply to this turn.
   *  When `false` the comment is posted for teammates with no AI reply, and the
   *  model controls (which only shape an AI turn) are disabled.
   *  Undefined on the floating chat — the AI always answers there, so no toggle
   *  renders. */
  aiReply?: boolean;
  /** Flip the AI-reply toggle. Presence of this handler is what renders the
   *  toggle — so the floating chat (which omits it) never shows it. */
  onAiReplyChange?: (next: boolean) => void;
  /** Metered model entries (models + saved profiles) for the picker's
   *  premium group (model-registry.md L10/L15). Empty/undefined hides the
   *  group — surfaces that don't wire metered keep the curated trio. */
  meteredOptions?: Array<{ key: string; label: string; sublabel: string }>;
  /** Currently selected metered entry key, or null when a curated tier is
   *  active. The owner runs the estimate→confirm flow before setting it. */
  meteredSelectedKey?: string | null;
  /** Pick a metered entry (key) or clear back to curated (null). */
  onMeteredSelect?: (key: string | null) => void;
  /** Workspace-owned OpenAI-compatible endpoints. */
  customOptions?: Array<{ key: string; label: string; sublabel: string }>;
  customSelectedKey?: string | null;
  onCustomSelect?: (key: string | null) => void;
  /** Row layout override (margin) for the host composer. */
  className?: string;
};

/**
 * Model and optional AI-reply controls. Research is automatic. Pure presentation — every prop is owned by the caller.
 */
export function ComposerControls({
  model,
  pickerLabel,
  onModelChange,
  plan,
  selectSide = "top",
  aiReply,
  onAiReplyChange,
  meteredOptions,
  meteredSelectedKey,
  onMeteredSelect,
  customOptions,
  customSelectedKey,
  onCustomSelect,
  className,
}: Props) {
  const t = useT().chat;
  const capabilities = deploymentCapabilities();
  const proDisabled = modelTierPlanGateApplies(capabilities, plan, "pro");
  const maxDisabled = modelTierPlanGateApplies(capabilities, plan, "max");
  const meteredDisabled = planGateApplies(capabilities, plan);
  const tc = useT().comments;
  // The AI-reply toggle shows only where a host wires it (the comment
  // composers). When the AI won't reply, the model controls — which
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
      <div className="flex-1" />
      <Select
        value={customSelectedKey ? `custom:${customSelectedKey}` : meteredSelectedKey ? `metered:${meteredSelectedKey}` : model}
        onValueChange={(v) => {
          if (!v) return;
          if (v.startsWith("custom:")) {
            onMeteredSelect?.(null);
            onCustomSelect?.(v.slice("custom:".length));
            return;
          }
          if (v.startsWith("metered:")) {
            onCustomSelect?.(null);
            onMeteredSelect?.(v.slice("metered:".length));
            return;
          }
          onCustomSelect?.(null);
          onMeteredSelect?.(null);
          onModelChange(v as ModelTier);
        }}
        disabled={aiTurnDisabled}
      >
        <SelectTrigger
          size="sm"
          aria-label={pickerLabel ?? t.modelLabel}
          disabled={aiTurnDisabled}
          className="gap-1.5 border-transparent bg-muted/60 text-[16px] hover:bg-muted disabled:pointer-events-none disabled:opacity-40 md:text-xs"
        >
          <span className="font-medium">
            {customSelectedKey
              ? customOptions?.find((o) => o.key === customSelectedKey)?.label ?? t.modelCustomGroup
              : meteredSelectedKey
              ? meteredOptions?.find((o) => o.key === meteredSelectedKey)?.label ?? t.modelMeteredGroup
              : model === "pro" ? t.modelPro : model === "max" ? t.modelMax : t.modelStandard}
          </span>
        </SelectTrigger>
        <SelectContent side={selectSide} align="end" alignItemWithTrigger={false} className="w-auto min-w-56">
          <SelectItem value="standard">
            <div className="flex flex-col gap-0.5 py-0.5">
              <span className="text-sm font-medium">{t.modelStandard}</span>
              <span className="text-[11px] text-muted-foreground">{t.modelStandardDesc}</span>
            </div>
          </SelectItem>
          <SelectItem value="pro" disabled={proDisabled}>
            <div className="flex flex-col gap-0.5 py-0.5">
              <span className="text-sm font-medium">{t.modelPro}</span>
              <span className="text-[11px] text-muted-foreground">{t.modelProDesc}</span>
            </div>
          </SelectItem>
          <SelectItem value="max" disabled={maxDisabled}>
            <div className="flex flex-col gap-0.5 py-0.5">
              <span className="text-sm font-medium">{t.modelMax}</span>
              <span className="text-[11px] text-muted-foreground">{t.modelMaxDesc}</span>
            </div>
          </SelectItem>
          {customOptions && customOptions.length > 0 ? (
            <>
              <div className="mt-1 border-t border-border/60 px-2 pb-0.5 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
                {t.modelCustomGroup}
              </div>
              {customOptions.map((o) => (
                <SelectItem key={o.key} value={`custom:${o.key}`}>
                  <div className="flex flex-col gap-0.5 py-0.5">
                    <span className="text-sm font-medium">{o.label}</span>
                    <span className="text-[11px] text-muted-foreground">{o.sublabel}</span>
                  </div>
                </SelectItem>
              ))}
            </>
          ) : null}
          {meteredOptions && meteredOptions.length > 0 ? (
            <>
              <div className="mt-1 border-t border-border/60 px-2 pb-0.5 pt-1.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
                {t.modelMeteredGroup}
              </div>
              {meteredOptions.map((o) => (
                <SelectItem key={o.key} value={`metered:${o.key}`} disabled={meteredDisabled}>
                  <div className="flex flex-col gap-0.5 py-0.5">
                    <span className="text-sm font-medium">{o.label}</span>
                    <span className="text-[11px] text-muted-foreground">{o.sublabel}</span>
                  </div>
                </SelectItem>
              ))}
            </>
          ) : null}
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
