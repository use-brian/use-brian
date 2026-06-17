"use client";

/**
 * Skills library — the Skills section's LANDING on every size
 * (docs/plans/brain-skill-management-ux.md §3.1, D1, as amended §11d —
 * library-first: the govern-first `SkillsHome` dashboard is retired and the
 * pane shows the skills themselves).
 *
 * The pane is a QUIET LIST in the entries recipe (`EntityRow` /
 * `grouped-view`): full-width borderless rows separated by `border-b`,
 * `hover:bg-muted/40`, no card borders, no primary blue. All the chrome the
 * pane used to own moved out in the §11a IA pass and stays out:
 *   - heading + count + "+ New skill" → the Brain TOPBAR right cluster
 *   - search + status/source/sensitivity filters → the SIDEBAR panel's
 *     compact filter popover (`brain-surface-context` is the shared state)
 *
 * On the UNFILTERED landing a pinned amber **Needs review** band leads:
 * the Suggested rows (one-click Confirm) under a faint amber wash, gone
 * entirely at zero — no all-clear filler. The band owns those rows, so the
 * main list below excludes them (never rendered twice). The moment any
 * search/filter is armed the band hides and the plain filtered list takes
 * over — so the topbar's "N suggested" chip (status filter) shows exactly
 * the suggested rows as ordinary rows. Split logic =
 * `partitionSkillsForLanding` (pure, unit-tested).
 *
 * A row carries: status dot (Active emerald / Suggested amber / Stale
 * muted — same encoding as the sidebar quick-list), name + description,
 * then quiet right-side meta (confidence %, enabled-assistant count,
 * relative last-invoked as muted text; sensitivity as the one badge — the
 * same recipe `EntityRow` uses). Suggested rows keep the inline Confirm
 * (the same trust action as the editor); row click navigates to the full
 * editor at `/w/[id]/brain/skills/[skillRowId]`.
 *
 * The filter arithmetic + ordering live in the pure `lib/skills-view.ts`
 * so they're unit-tested.
 *
 * [COMP:app-web/brain-skills-view]
 */

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useT, useLocale, format } from "@/lib/i18n/client";
import {
  confirmSkill,
  type WorkspaceSkillSummary,
} from "@/lib/api/skills";
import { requestBrainRefresh } from "@/lib/brain-events";
import {
  hasLibraryFilter,
  partitionSkillsForLanding,
  skillStatus,
} from "@/lib/skills-view";
import { useBrainSurface } from "@/contexts/brain-surface-context";
import { Button } from "@/components/ui/button";

type Props = {
  workspaceId: string;
  /** `null` ⇒ still loading (the Brain page owns the fetch + refresh). */
  skills: WorkspaceSkillSummary[] | null;
  /** Opens the creator (full-pane takeover owned by the Brain page). */
  onNewSkill: () => void;
  /** Row click → the editor route. */
  onOpenSkill: (skill: WorkspaceSkillSummary) => void;
};

/** Largest-unit relative time ("3 days ago"), locale-aware. Same shape as
 *  the workflow sidebar panel's next-run formatter, pointed backwards. */
function relativeWhen(iso: string, locale: string): string {
  const intlLocale = locale === "zh" ? "zh-Hant" : locale;
  const rtf = new Intl.RelativeTimeFormat(intlLocale, { numeric: "auto" });
  const diffMs = new Date(iso).getTime() - Date.now();
  const minutes = Math.round(diffMs / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(diffMs / 3_600_000);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(diffMs / 86_400_000);
  if (Math.abs(days) < 30) return rtf.format(days, "day");
  const months = Math.round(diffMs / (30 * 86_400_000));
  return rtf.format(months, "month");
}

export function SkillsLibrary({
  workspaceId,
  skills,
  onNewSkill,
  onOpenSkill,
}: Props) {
  const t = useT();
  const locale = useLocale();
  const skillsCopy = t.brainPage.skills;
  const copy = t.brainPage.skillsLibrary;

  // Every filter is shared context — the sidebar popover is the one filter
  // surface; this pane just renders the filtered list.
  const {
    search,
    skillStatusFilter: statuses,
    skillSourceFilter: sources,
    skillSensitivityFilter: sensitivities,
  } = useBrainSurface();

  // Inline-confirm busy marker so a slow confirm can't double-fire.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Landing split: the band pins the Suggested rows while unfiltered; any
  // armed search/filter collapses it into the one plain list (§11d).
  const { band, list } = useMemo(
    () =>
      partitionSkillsForLanding(skills ?? [], {
        search,
        statuses,
        sources,
        sensitivities,
      }),
    [skills, search, statuses, sources, sensitivities],
  );

  const hasFilter = hasLibraryFilter({
    search,
    statuses,
    sources,
    sensitivities,
  });

  async function handleConfirm(skill: WorkspaceSkillSummary) {
    setConfirmingId(skill.rowId);
    setError(null);
    const result = await confirmSkill(workspaceId, skill.rowId);
    setConfirmingId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // The Brain page refetches the skill list on this event — the row flips
    // to Active without local optimistic state.
    requestBrainRefresh(workspaceId);
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-background">
      {/* pb-28 clears the fixed chat dock floated over the surface bottom-right. */}
      <div className="flex flex-col pb-28">
        {error && (
          <p className="px-4 pt-3 text-xs text-red-500" role="alert">
            {error}
          </p>
        )}

        {/* Rows / empty states. */}
        {skills === null ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            …
          </div>
        ) : skills.length === 0 ? (
          <div className="mx-4 mt-4 flex flex-col items-center gap-1.5 rounded-md border border-dashed border-border bg-card/50 px-4 py-10 text-center">
            <p className="text-sm font-medium text-foreground">
              {skillsCopy.emptyTitle}
            </p>
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
              {skillsCopy.emptyBody}
            </p>
            <Button variant="outline" size="sm" onClick={onNewSkill} className="mt-2">
              {skillsCopy.newSkill}
            </Button>
          </div>
        ) : band.length === 0 && list.length === 0 && hasFilter ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            {copy.noMatches}
          </div>
        ) : (
          <>
            {/* Needs review — the pinned governance band (unfiltered landing
                only; gone entirely at zero). Faint amber wash bounds it, the
                same family as the editor's Suggested rail card. */}
            {band.length > 0 && (
              /* The rows' own border-b draws the section's bottom seam. */
              <section className="bg-amber-500/[0.04]">
                <h2 className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700/80 dark:text-amber-400/80">
                  {format(copy.needsReview, { count: band.length })}
                </h2>
                <ul className="flex flex-col">
                  {band.map((skill) => (
                    <SkillRow
                      key={skill.rowId}
                      skill={skill}
                      locale={locale}
                      confirming={confirmingId === skill.rowId}
                      onOpen={() => onOpenSkill(skill)}
                      onConfirm={() => void handleConfirm(skill)}
                    />
                  ))}
                </ul>
              </section>
            )}
            <ul className="flex flex-col">
              {list.map((skill) => (
                <SkillRow
                  key={skill.rowId}
                  skill={skill}
                  locale={locale}
                  confirming={confirmingId === skill.rowId}
                  onOpen={() => onOpenSkill(skill)}
                  onConfirm={() => void handleConfirm(skill)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function SkillRow({
  skill,
  locale,
  confirming,
  onOpen,
  onConfirm,
}: {
  skill: WorkspaceSkillSummary;
  locale: string;
  confirming: boolean;
  onOpen: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const skillsCopy = t.brainPage.skills;
  const copy = t.brainPage.skillsLibrary;
  const status = skillStatus(skill);

  const statusLabel =
    status === "active"
      ? skillsCopy.statusActive
      : status === "suggested"
        ? skillsCopy.statusSuggested
        : skillsCopy.statusStale;

  return (
    <li className="flex items-center border-b border-border">
      {/* The main click target is its own button (not the row) so the inline
          Confirm isn't a nested interactive element. */}
      <button
        type="button"
        onClick={onOpen}
        className="flex-1 min-w-0 flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
      >
        {/* Status dot — the same encoding as the sidebar quick-list. */}
        <span
          aria-hidden
          title={statusLabel}
          className={cn(
            "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
            status === "active" && "bg-emerald-500",
            status === "suggested" && "bg-amber-500",
            status === "stale" && "bg-muted-foreground/40",
          )}
        />
        <span className="sr-only">{statusLabel}</span>

        <span className="flex-1 min-w-0 flex flex-col">
          <span className="text-sm font-medium truncate">{skill.name}</span>
          {skill.description && (
            <span className="text-xs text-muted-foreground truncate">
              {skill.description}
            </span>
          )}
        </span>

        {/* Quiet right-side meta — muted text, no boxes. */}
        <span className="hidden sm:inline shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {Math.round(skill.confidence * 100)}%
        </span>
        <span className="hidden lg:inline shrink-0 text-[11px] text-muted-foreground">
          {skill.enabledAssistantIds.length === 1
            ? copy.assistantsOne
            : format(copy.assistantsMany, {
                count: skill.enabledAssistantIds.length,
              })}
          {" · "}
          {skill.lastInvokedAt
            ? format(copy.lastUsed, {
                when: relativeWhen(skill.lastInvokedAt, locale),
              })
            : copy.neverUsed}
        </span>

        {/* The one badge — sensitivity, in the same recipe EntityRow uses. */}
        <span
          className={cn(
            "hidden md:inline-block shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium border",
            skill.sensitivity === "confidential" &&
              "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
            skill.sensitivity === "internal" &&
              "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
            skill.sensitivity === "public" &&
              "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
          )}
        >
          {skillsCopy.sensitivity[skill.sensitivity]}
        </span>
      </button>

      {/* Inline trust action — Suggested rows confirm without leaving the
          library (the same `POST /:id/confirm` as the drawer/editor). */}
      {status === "suggested" && (
        <div className="shrink-0 px-3">
          <Button
            size="xs"
            variant="outline"
            disabled={confirming}
            onClick={onConfirm}
            aria-label={skillsCopy.confirm}
          >
            {skillsCopy.confirm}
          </Button>
        </div>
      )}
    </li>
  );
}
