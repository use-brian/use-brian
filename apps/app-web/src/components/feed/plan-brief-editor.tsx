"use client";

/**
 * The month-brief editor, as a rail overlay: the once-per-month artefact the
 * operator and the assistant iterate (feed-revamp.md D8), opened from the
 * plan chat rail's context header and returning to the conversation on Back
 * (docs/plans/feed-plan-chat-first.md P2/P9).
 *
 * Extracted from the retired widget rail's `view === "brief"` branch so the
 * editor survives the rail becoming the plan chat. It edits as a document,
 * not a labelled form card, per the locked app-web editor idiom.
 *
 * [COMP:app-web/feed-plan-brief-editor]
 */

import { useEffect, useState } from "react";
import { ArrowLeft, CircleHelp } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { Tooltip } from "@/components/ui/tooltip";
import type { PlanBrief } from "@/lib/feed-plan";

/**
 * The cadence field is a free text input, so anything can arrive. Out-of-range
 * or unparseable means "no cadence" rather than an error: the only thing it
 * drives is a dashed suggestion, and refusing to save a brief because someone
 * typed "3x" would be wildly out of proportion. The server re-validates.
 */
function parseCadenceInput(raw: string): number | null {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 21) return null;
  return n;
}

function FieldHelp({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      label={
        <span className="block max-w-64 whitespace-normal text-left font-normal leading-relaxed">
          {label}
        </span>
      }
      side="left"
      delay={200}
      closeOnClick={false}
      open={open}
      onOpenChange={setOpen}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/55 transition-colors hover:text-muted-foreground"
      >
        <CircleHelp className="size-3.5" aria-hidden />
      </button>
    </Tooltip>
  );
}

export function PlanBriefEditor({
  brief,
  canEdit,
  busy,
  onSave,
  onBack,
}: {
  brief: PlanBrief | null;
  canEdit: boolean;
  busy: boolean;
  onSave: (next: {
    brief: string;
    themes: string[];
    cadencePerWeek: number | null;
  }) => void;
  onBack: () => void;
}) {
  const tp = useT().feedPage.plan;

  const [body, setBody] = useState(brief?.brief ?? "");
  const [themes, setThemes] = useState((brief?.themes ?? []).join(", "));
  const [cadence, setCadence] = useState(
    brief?.cadencePerWeek ? String(brief.cadencePerWeek) : "",
  );

  // Re-seed the editor when the month (and so the brief) changes underneath.
  useEffect(() => {
    setBody(brief?.brief ?? "");
    setThemes((brief?.themes ?? []).join(", "));
    setCadence(brief?.cadencePerWeek ? String(brief.cadencePerWeek) : "");
  }, [brief]);

  const dirty =
    body !== (brief?.brief ?? "") ||
    themes !== (brief?.themes ?? []).join(", ") ||
    cadence !== (brief?.cadencePerWeek ? String(brief.cadencePerWeek) : "");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/60 px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label={tp.backToBrief}
          title={tp.backToBrief}
          className="inline-flex h-6 items-center gap-1.5 rounded text-[12.5px] font-medium text-foreground transition-colors hover:text-muted-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {tp.briefHeading}
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-3">
        {/* Labels make the save boundary explicit; the action stays beside
            its fields. */}
        <section className="space-y-3" aria-labelledby="plan-brief-heading">
          <div className="flex items-center gap-1">
            <h3
              id="plan-brief-heading"
              className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
            >
              {tp.briefHeading}
            </h3>
            <FieldHelp label={tp.briefDescription} />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="plan-goal"
              className="text-[11px] font-medium text-foreground"
            >
              {tp.goalLabel}
            </label>
            <textarea
              id="plan-goal"
              value={body}
              disabled={!canEdit}
              onChange={(e) => setBody(e.target.value)}
              placeholder={tp.briefPlaceholder}
              rows={5}
              className="w-full resize-y rounded-lg border border-border/60 bg-background px-2.5 py-2 text-[12.5px] leading-relaxed transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none focus-visible:shadow-none disabled:opacity-70"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="plan-themes"
              className="text-[11px] font-medium text-foreground"
            >
              {tp.themesLabel}
            </label>
            <input
              id="plan-themes"
              type="text"
              value={themes}
              disabled={!canEdit}
              onChange={(e) => setThemes(e.target.value)}
              placeholder={tp.themesPlaceholder}
              className="h-8 w-full rounded-lg border border-border/60 bg-background px-2.5 text-[12.5px] transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none focus-visible:shadow-none disabled:opacity-70"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <label
                htmlFor="plan-cadence"
                className="text-[11px] font-medium text-foreground"
              >
                {tp.cadenceLabel}
              </label>
              <FieldHelp label={tp.cadenceHint} />
              <input
                id="plan-cadence"
                type="number"
                min={1}
                max={21}
                inputMode="numeric"
                value={cadence}
                disabled={!canEdit}
                onChange={(e) => setCadence(e.target.value)}
                className="h-7 w-14 rounded-md border border-border/60 bg-background px-2 text-[12.5px] tabular-nums transition-colors focus:border-primary/40 focus:outline-none focus-visible:shadow-none disabled:opacity-70"
              />
              <span className="text-[11px] text-muted-foreground">
                {tp.cadenceUnit}
              </span>
            </div>
          </div>

          {brief?.updatedAt ? (
            <p className="text-[11px] text-muted-foreground">
              {format(tp.briefUpdated, {
                when: new Date(brief.updatedAt).toLocaleDateString(),
              })}
            </p>
          ) : null}

          {canEdit ? (
            <button
              type="button"
              data-plan-brief-action
              disabled={!dirty || busy}
              onClick={() =>
                onSave({
                  brief: body,
                  themes: themes
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  cadencePerWeek: parseCadenceInput(cadence),
                })
              }
              className="inline-flex h-8 w-full items-center justify-center rounded-lg bg-action px-3 text-[12.5px] font-medium text-action-foreground transition-colors hover:bg-action/90 disabled:opacity-50"
            >
              {tp.saveBrief}
            </button>
          ) : null}
        </section>
      </div>
    </div>
  );
}
