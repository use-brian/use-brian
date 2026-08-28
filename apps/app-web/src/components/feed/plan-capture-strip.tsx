"use client";

/**
 * Capture-first strip on the Plan index (feed-plan-chat-first.md P5-P6, P8):
 * ONE verb — Enter logs an idea, always. The idea/draft fork is a premature
 * commitment at capture time, so escalation appears AFTER the jot is safely
 * down: an inline row on the just-logged idea offering `Draft now` (P7's
 * direct idea → draft, no calendar date needed) and `Plan it` (the D24
 * prefilled slot editor), plus the same pair on every backlog row.
 *
 * The collapsible Ideas tray below the input is the relocated backlog list
 * (the retired widget rail's tray) — capture lives here in the main column,
 * where it also works below `lg` for the first time (the old rail was
 * `hidden lg:block`).
 *
 * [COMP:app-web/feed-capture-strip]
 */

import { useState } from "react";
import {
  CalendarPlus,
  Check,
  ChevronRight,
  Lightbulb,
  PenLine,
  Plus,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import type { FeedIdea } from "@/lib/feed-plan";

export function PlanCaptureStrip({
  canEdit,
  ideas,
  busy,
  onLogIdea,
  onDraftIdea,
  onPlanIdea,
  onDiscardIdea,
}: {
  canEdit: boolean;
  /** The open backlog, newest first. */
  ideas: readonly FeedIdea[];
  busy: boolean;
  /** Resolves the saved idea (null on failure) so the strip can offer escalation. */
  onLogIdea: (text: string) => Promise<FeedIdea | null>;
  onDraftIdea: (idea: FeedIdea) => void;
  onPlanIdea: (idea: FeedIdea) => void;
  onDiscardIdea: (idea: FeedIdea) => void;
}) {
  const tp = useT().feedPage.plan;
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  /** The just-captured jot, while its escalation row is showing. */
  const [logged, setLogged] = useState<FeedIdea | null>(null);
  const [trayOpen, setTrayOpen] = useState(false);

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const idea = await onLogIdea(trimmed);
      if (idea) {
        setText("");
        setLogged(idea);
      }
    } finally {
      setSaving(false);
    }
  }

  function escalate(action: (idea: FeedIdea) => void) {
    if (!logged) return;
    const idea = logged;
    setLogged(null);
    action(idea);
  }

  return (
    <section data-plan-capture-strip className="space-y-2">
      {canEdit ? (
        <div className="rounded-xl border border-border/60 bg-card px-3 py-2.5 shadow-xs">
          <div className="flex items-end gap-2">
            <PenLine
              className="mb-2 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <textarea
              value={text}
              rows={Math.min(3, Math.max(1, text.split("\n").length))}
              disabled={saving}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder={tp.capturePlaceholder}
              aria-label={tp.capturePlaceholder}
              className="min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus:outline-none disabled:opacity-70"
            />
            <button
              type="button"
              disabled={!text.trim() || saving}
              onClick={() => void submit()}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-foreground px-3 text-[12.5px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
            >
              <Plus className="size-3.5" aria-hidden />
              {tp.captureLog}
            </button>
          </div>
        </div>
      ) : null}

      {/* Escalation AFTER capture (P6): the thought is down; now it can
          become a post or a dated slot, or just wait in the backlog. */}
      {canEdit && logged ? (
        <div
          data-plan-capture-escalation
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5 text-[12.5px]"
        >
          <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <Check className="size-3.5 shrink-0" aria-hidden />
            <span className="shrink-0 font-medium text-foreground">
              {tp.captureLogged}
            </span>
            <span className="min-w-0 truncate">{logged.text}</span>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => escalate(onDraftIdea)}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
            >
              <PenLine className="size-3" aria-hidden />
              {tp.captureDraftNow}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => escalate(onPlanIdea)}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
            >
              <CalendarPlus className="size-3" aria-hidden />
              {tp.planIdea}
            </button>
            <button
              type="button"
              onClick={() => setLogged(null)}
              aria-label={tp.captureDismiss}
              title={tp.captureDismiss}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        </div>
      ) : null}

      {/* The relocated backlog tray (P8): count always visible, list on
          demand. Read-only members can browse; actions stay edit-gated. */}
      <div>
        <button
          type="button"
          data-plan-ideas-toggle
          aria-expanded={trayOpen}
          onClick={() => setTrayOpen((open) => !open)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", trayOpen && "rotate-90")}
            aria-hidden
          />
          <Lightbulb className="size-3.5" aria-hidden />
          {tp.ideasHeading}
          <span className="rounded-full border border-border px-1.5 text-[11px] tabular-nums">
            {ideas.length}
          </span>
        </button>

        {trayOpen ? (
          ideas.length === 0 ? (
            <p className="mt-1.5 rounded-lg border border-dashed border-border p-2.5 text-[12px] leading-relaxed text-muted-foreground">
              {tp.ideasEmpty}
            </p>
          ) : (
            <ul className="mt-1.5 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
              {ideas.map((idea) => (
                <li
                  key={idea.id}
                  className="rounded-lg border border-border/60 bg-card p-2"
                >
                  <p className="line-clamp-3 whitespace-pre-wrap text-[12.5px] leading-relaxed">
                    {idea.text}
                  </p>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {new Date(idea.createdAt).toLocaleDateString()}
                  </div>
                  {canEdit ? (
                    <div className="mt-2 flex items-center gap-1">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onDraftIdea(idea)}
                        className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
                      >
                        <PenLine className="size-3" aria-hidden />
                        {tp.draftIdea}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onPlanIdea(idea)}
                        className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
                      >
                        <CalendarPlus className="size-3" aria-hidden />
                        {tp.planIdea}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await confirmDialog({
                            title: tp.discardIdeaTitle,
                            description: format(tp.discardIdeaBody, {
                              text: idea.text,
                            }),
                            confirmLabel: tp.discardIdeaConfirm,
                            variant: "destructive",
                          });
                          if (ok) onDiscardIdea(idea);
                        }}
                        aria-label={tp.discardIdea}
                        title={tp.discardIdea}
                        className="inline-flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </section>
  );
}
