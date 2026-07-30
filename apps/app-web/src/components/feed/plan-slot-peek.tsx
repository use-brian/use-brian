"use client";

/**
 * The plan rail's slot editor: one dated intent, edited as a small document
 * (borderless title, auto-growing brief) with a properties block and exactly
 * one primary action, per the locked app-web editor idiom.
 *
 * Doubles as the create form. A new slot is the same shape with no id yet, so
 * a single component serves "click + on a day" and "click an existing chip"
 * instead of two forms that drift apart.
 *
 * Secondary mutations (skip / unskip) apply instantly. Only the title and
 * brief are held until Save, because they are the fields a half-typed value
 * would corrupt.
 *
 * [COMP:app-web/plan-slot-peek]
 */

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, MessageSquare, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { StatusLabel } from "@/components/feed/feed-status";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { FEED_PLATFORMS, type FeedPlatform } from "@/lib/feed-nav";
import { parseIsoDay, type PlanSlot } from "@/lib/feed-plan";

export type PlanSlotDraft = {
  id: string | null;
  platform: FeedPlatform;
  scheduledFor: string;
  title: string;
  brief: string;
  /** Set when this draft was opened from a backlog idea ("Plan it"); saving
   *  the new slot binds the idea to it so the jot leaves the open backlog. */
  fromIdeaId?: string;
};

export function planSlotToDraft(slot: PlanSlot): PlanSlotDraft {
  return {
    id: slot.id,
    platform: slot.platform,
    scheduledFor: slot.scheduledFor,
    title: slot.title,
    brief: slot.brief ?? "",
  };
}

export function PlanSlotPeek({
  draft,
  slot,
  canEdit,
  busy,
  onChange,
  onSave,
  onDelete,
  onDraftThis,
  onOpenDraft,
  onToggleSkip,
  onDiscuss,
  onBack,
}: {
  draft: PlanSlotDraft;
  /** The persisted slot, absent while creating. Carries the derived status. */
  slot: PlanSlot | null;
  canEdit: boolean;
  busy: boolean;
  onChange: (draft: PlanSlotDraft) => void;
  onSave: () => void;
  onDelete: () => void;
  onDraftThis: () => void;
  onOpenDraft: () => void;
  onToggleSkip: () => void;
  onDiscuss: () => void;
  onBack: () => void;
}) {
  const t = useT().feedPage;
  const tp = t.plan;
  const titleRef = useRef<HTMLInputElement>(null);

  // A brand-new slot opens focused on its title: the operator clicked a day
  // meaning to name something, so the cursor should already be there.
  const isNew = draft.id === null;
  useEffect(() => {
    if (isNew) titleRef.current?.focus();
  }, [isNew]);

  const dayLabel = (() => {
    const parsed = parseIsoDay(draft.scheduledFor);
    return parsed
      ? new Intl.DateTimeFormat(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        }).format(parsed)
      : draft.scheduledFor;
  })();

  const dirty =
    !!slot &&
    (slot.title !== draft.title.trim() ||
      (slot.brief ?? "") !== draft.brief.trim() ||
      slot.platform !== draft.platform);
  const canSave = canEdit && draft.title.trim().length > 0 && (isNew || dirty);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label={tp.backToBrief}
          title={tp.backToBrief}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
          {isNew ? tp.newSlotTitle : dayLabel}
        </span>
        {slot ? (
          <StatusLabel
            status={slot.status}
            label={tp.slotStatus[slot.status]}
            className="shrink-0 pr-1"
          />
        ) : null}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <input
          ref={titleRef}
          type="text"
          value={draft.title}
          disabled={!canEdit}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
          placeholder={tp.slotTitlePlaceholder}
          className="w-full border-0 bg-transparent p-0 text-[15px] font-semibold placeholder:text-muted-foreground/60 focus:outline-none disabled:opacity-70"
        />

        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {tp.platformLabel}
          </div>
          <div className="flex flex-wrap gap-1">
            {FEED_PLATFORMS.map((p) => {
              const active = p === draft.platform;
              return (
                <button
                  key={p}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => onChange({ ...draft, platform: p })}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors disabled:opacity-60",
                    active
                      ? "border-transparent bg-foreground text-background"
                      : "border-border bg-background text-muted-foreground hover:bg-accent",
                  )}
                >
                  <PlatformIcon platform={p} className="size-3" />
                  {t.platformLabels[p]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {tp.briefLabel}
          </div>
          <textarea
            value={draft.brief}
            disabled={!canEdit}
            onChange={(e) => onChange({ ...draft, brief: e.target.value })}
            placeholder={tp.slotBriefPlaceholder}
            rows={5}
            className="w-full resize-y rounded-lg border border-border/60 bg-background px-2.5 py-2 text-[12.5px] leading-relaxed placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none disabled:opacity-70"
          />
          <p className="text-[11px] text-muted-foreground">{tp.briefHint}</p>
        </div>
      </div>

      {canEdit ? (
        <div className="space-y-2 border-t border-border/60 p-3">
          {/* Exactly one primary action, and it changes with the state: name
              the slot, then write it, then open what you wrote. */}
          {isNew || dirty ? (
            <button
              type="button"
              onClick={onSave}
              disabled={!canSave || busy}
              className="inline-flex h-8 w-full items-center justify-center rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {isNew ? tp.createSlot : tp.saveSlot}
            </button>
          ) : slot?.sessionId ? (
            <button
              type="button"
              onClick={onOpenDraft}
              className="inline-flex h-8 w-full items-center justify-center rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {tp.openDraft}
            </button>
          ) : (
            <button
              type="button"
              onClick={onDraftThis}
              disabled={busy}
              className="inline-flex h-8 w-full items-center justify-center rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {tp.draftThis}
            </button>
          )}

          {slot ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onDiscuss}
                className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-2 text-[12.5px] font-medium transition-colors hover:bg-accent"
              >
                <MessageSquare className="size-3.5" aria-hidden />
                {tp.discussSlot}
              </button>
              <button
                type="button"
                onClick={onToggleSkip}
                disabled={busy}
                className="inline-flex h-8 flex-1 items-center justify-center rounded-lg border border-border px-2 text-[12.5px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
              >
                {slot.status === "skipped" ? tp.unskipSlot : tp.skipSlot}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: tp.deleteSlotTitle,
                    description: format(tp.deleteSlotBody, {
                      title: slot.title,
                    }),
                    confirmLabel: tp.deleteSlotConfirm,
                    variant: "destructive",
                  });
                  if (ok) onDelete();
                }}
                aria-label={tp.deleteSlot}
                title={tp.deleteSlot}
                className="inline-flex size-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
