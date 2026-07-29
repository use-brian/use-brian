"use client";

/**
 * Suggest groups — the bulk review pass over a library that accumulated
 * skills faster than anyone filed them.
 *
 * A workspace that has been running a while has dozens of skills, its own
 * plus everything the background curator induced, and every one of them sits
 * in the `custom` sink because nothing set `category` before the editor
 * picker existed. Re-filing them one editor visit at a time is the friction
 * this removes.
 *
 * Three stages, and the middle one is the point:
 *
 *   intent  — states how many skills are unsorted and asks before spending
 *             anything. The count is a free client-side read of the list the
 *             page already has, so the cost is named before it is incurred
 *             (the pre-flight-confirm invariant).
 *   review  — every proposed move as a checked row, grouped by target, each
 *             with a per-row override. The model is guessing a bucket from a
 *             name and a description; nothing here is applied unchecked.
 *   done    — how many moved, and anything that did not.
 *
 * Applying sends ONLY `category` per skill, which is metadata — so a bulk
 * re-file does not carry the D2 edit-is-confirm stamp and cannot silently
 * verify and activate every Suggested skill it touches.
 *
 * Spec: docs/architecture/engine/skill-system.md → "Suggesting groups".
 *
 * [COMP:app-web/brain-skill-groups]
 */

import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Check, Loader2, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  applySkillGroups,
  suggestSkillGroups,
  type SkillGroupSuggestion,
  type WorkspaceSkillSummary,
} from "@/lib/api/skills";
import {
  skillCategoryOf,
  SKILL_CATEGORIES,
  type SkillCategory,
} from "@/lib/skills-view";

type Props = {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** The library's current rows — the unsorted count comes from these, so the
   *  intent stage costs nothing. */
  skills: WorkspaceSkillSummary[];
  /** Fired after a successful apply so the page refetches. */
  onApplied: () => void;
};

type Row = SkillGroupSuggestion & { chosen: SkillCategory; checked: boolean };

export function SkillGroupsDialog({
  workspaceId,
  open,
  onClose,
  skills,
  onApplied,
}: Props) {
  const t = useT();
  const copy = t.brainPage.skillGroups;
  const categoryCopy = t.brainPage.skillsLibrary.categories;

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [applied, setApplied] = React.useState<{ updated: number; failed: number } | null>(null);

  const unsorted = React.useMemo(
    () => skills.filter((s) => skillCategoryOf(s) === "custom").length,
    [skills],
  );

  // Reopening starts clean — a stale review list would apply decisions the
  // user made against a library that has since moved.
  React.useEffect(() => {
    if (!open) {
      setBusy(false);
      setError(null);
      setRows(null);
      setApplied(null);
    }
  }, [open]);

  async function runSuggest() {
    setBusy(true);
    setError(null);
    const res = await suggestSkillGroups(workspaceId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRows(
      res.suggestions.map((s) => ({
        ...s,
        chosen: (s.suggested as SkillCategory) ?? "custom",
        checked: true,
      })),
    );
  }

  async function apply() {
    if (!rows) return;
    const assignments = rows
      .filter((r) => r.checked)
      .map((r) => ({ skillRowId: r.skillRowId, category: r.chosen }));
    if (assignments.length === 0) return;

    setBusy(true);
    setError(null);
    const res = await applySkillGroups(workspaceId, assignments);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setApplied({ updated: res.updated, failed: res.failed.length });
    onApplied();
  }

  const checkedCount = rows?.filter((r) => r.checked).length ?? 0;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(46rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background p-5 shadow-xl">
          <Dialog.Title className="text-sm font-semibold text-foreground">
            {copy.title}
          </Dialog.Title>

          {/* ── Done ── */}
          {applied ? (
            <div className="mt-4">
              <p className="text-sm text-foreground">
                {format(copy.appliedBody, { count: applied.updated })}
              </p>
              {applied.failed > 0 && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {format(copy.appliedFailed, { count: applied.failed })}
                </p>
              )}
              <div className="mt-6 flex justify-end">
                <Button variant="default" size="sm" onClick={onClose}>
                  {copy.done}
                </Button>
              </div>
            </div>
          ) : rows === null ? (
            /* ── Intent: name the scope before spending anything ── */
            <div className="mt-4">
              <p className="text-sm leading-relaxed text-muted-foreground">
                {unsorted === 0
                  ? copy.nothingToGroup
                  : format(copy.intentBody, { count: unsorted })}
              </p>
              {unsorted > 0 && (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {copy.intentHint}
                </p>
              )}
              {error && (
                <p role="alert" className="mt-3 text-xs leading-relaxed text-red-500">
                  {error}
                </p>
              )}
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={onClose}>
                  {copy.cancel}
                </Button>
                {unsorted > 0 && (
                  <Button variant="default" size="sm" disabled={busy} onClick={() => void runSuggest()}>
                    {busy ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        {copy.suggesting}
                      </>
                    ) : (
                      <>
                        <Sparkles className="size-3.5" aria-hidden />
                        {copy.suggestCta}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          ) : rows.length === 0 ? (
            /* The model looked and left everything where it was — a real
               answer, not an error. */
            <div className="mt-4">
              <p className="text-sm leading-relaxed text-muted-foreground">
                {copy.noSuggestions}
              </p>
              <div className="mt-6 flex justify-end">
                <Button variant="outline" size="sm" onClick={onClose}>
                  {copy.close}
                </Button>
              </div>
            </div>
          ) : (
            /* ── Review ── */
            <>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {format(copy.reviewBody, { count: rows.length })}
              </p>

              <ul className="mt-4 min-h-0 flex-1 overflow-y-auto">
                {rows.map((row, i) => (
                  <li
                    key={row.skillRowId}
                    className="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0"
                  >
                    <input
                      type="checkbox"
                      checked={row.checked}
                      aria-label={format(copy.includeAria, { name: row.name })}
                      onChange={(e) => {
                        const next = [...rows];
                        next[i] = { ...row, checked: e.target.checked };
                        setRows(next);
                      }}
                      className="size-4 shrink-0 accent-primary"
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          "truncate text-sm",
                          row.checked ? "text-foreground" : "text-muted-foreground line-through",
                        )}
                      >
                        {row.name}
                      </p>
                      {row.rationale && (
                        <p className="truncate text-xs text-muted-foreground">{row.rationale}</p>
                      )}
                    </div>
                    <div className="w-40 shrink-0">
                      <SearchableSelect
                        value={row.chosen}
                        onValueChange={(next) => {
                          const updated = [...rows];
                          updated[i] = {
                            ...row,
                            chosen: (next || "custom") as SkillCategory,
                          };
                          setRows(updated);
                        }}
                        items={SKILL_CATEGORIES.map((value) => ({
                          value,
                          label: categoryCopy[value],
                        }))}
                        placeholder={copy.groupLabel}
                        aria-label={format(copy.groupAria, { name: row.name })}
                      />
                    </div>
                  </li>
                ))}
              </ul>

              {error && (
                <p role="alert" className="mt-3 text-xs leading-relaxed text-red-500">
                  {error}
                </p>
              )}

              <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
                <button
                  type="button"
                  onClick={() => {
                    const allOn = checkedCount === rows.length;
                    setRows(rows.map((r) => ({ ...r, checked: !allOn })));
                  }}
                  className="text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                >
                  {checkedCount === rows.length ? copy.deselectAll : copy.selectAll}
                </button>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={onClose}>
                    {copy.cancel}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    disabled={busy || checkedCount === 0}
                    onClick={() => void apply()}
                  >
                    {busy ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        {copy.applying}
                      </>
                    ) : (
                      <>
                        <Check className="size-3.5" aria-hidden />
                        {format(copy.applyCta, { count: checkedCount })}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
