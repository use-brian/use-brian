"use client";

/**
 * Blueprints library — the Blueprints section's landing in the Brain surface.
 *
 * Blueprints and skills are sibling specs (one is structural, one procedural),
 * so this reuses the `SkillsLibrary` pattern: a QUIET LIST of full-width
 * borderless rows (`border-b`, `hover:bg-muted/40`, no card borders, no primary
 * blue). Each row carries a blueprint glyph, the name + description, a quiet
 * section-count meta, and a "Blueprint" badge; a trailing Delete asks through
 * `confirmDialog` (NEVER `window.confirm`). A "+ New blueprint" affordance seeds
 * a blank blueprint doc (a heading + an empty extraction slot) and opens it in
 * the editor.
 *
 * A BLUEPRINT is a workspace page template carrying an `extraction` spec; the
 * list API returns every template, so the filter (`filterBlueprints`) keeps only
 * the ones with a spec. The pure filter + the section-count helper live in
 * `lib/blueprints.ts` so they're unit-tested (app-web has no component-render
 * test setup).
 *
 * Spec: docs/architecture/brain/structural-synthesis.md -> "The blueprint
 * object" ("Blueprints are managed in a Brain -> Blueprints library").
 *
 * [COMP:web/blueprints-library]
 */

import { useMemo, useState } from "react";
import { FileStack, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import type { CustomPageTemplateSummary } from "@sidanclaw/doc-model";
import {
  blueprintSectionCount,
  filterBlueprints,
} from "@/lib/blueprints";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";

type Props = {
  workspaceId: string;
  /** `null` ⇒ still loading (the Brain page owns the fetch + refresh). */
  blueprints: CustomPageTemplateSummary[] | null;
  /** Free-text needle (the shared Brain `search`); matches name + description. */
  search: string;
  /** Seeds + opens a blank blueprint doc (the Brain page owns the create flow). */
  onNewBlueprint: () => void;
  /** Delete a blueprint after a confirm resolves true (the page does the API call). */
  onDeleteBlueprint: (template: CustomPageTemplateSummary) => void;
};

export function BlueprintsLibrary({
  blueprints,
  search,
  onNewBlueprint,
  onDeleteBlueprint,
}: Props) {
  const t = useT();
  const copy = t.brainPage.blueprints;

  // Blueprint subset (templates with an extraction spec), name-sorted, then the
  // shared search needle over name + description.
  const list = useMemo(() => {
    const onlyBlueprints = filterBlueprints(blueprints ?? []);
    const needle = search.trim().toLowerCase();
    if (!needle) return onlyBlueprints;
    return onlyBlueprints.filter((b) =>
      `${b.name} ${b.description ?? ""}`.toLowerCase().includes(needle),
    );
  }, [blueprints, search]);

  const hasSearch = search.trim().length > 0;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-background">
      {/* pb-28 clears the fixed chat dock floated over the surface bottom-right. */}
      <div className="flex flex-col pb-28">
        {blueprints === null ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            …
          </div>
        ) : filterBlueprints(blueprints).length === 0 ? (
          <div className="mx-4 mt-4 flex flex-col items-center gap-1.5 rounded-md border border-dashed border-border bg-card/50 px-4 py-10 text-center">
            <p className="text-sm font-medium text-foreground">
              {copy.emptyTitle}
            </p>
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
              {copy.emptyBody}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={onNewBlueprint}
              className="mt-2"
            >
              {copy.newBlueprint}
            </Button>
          </div>
        ) : list.length === 0 && hasSearch ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            {copy.noMatches}
          </div>
        ) : (
          <ul className="flex flex-col">
            {list.map((blueprint) => (
              <BlueprintRow
                key={blueprint.id}
                blueprint={blueprint}
                onDelete={() => onDeleteBlueprint(blueprint)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function BlueprintRow({
  blueprint,
  onDelete,
}: {
  blueprint: CustomPageTemplateSummary;
  onDelete: () => void;
}) {
  const t = useT();
  const copy = t.brainPage.blueprints;
  const sections = blueprintSectionCount(blueprint);

  async function handleDelete() {
    const ok = await confirmDialog({
      title: copy.deleteTitle,
      description: format(copy.deleteBody, { name: blueprint.name }),
      confirmLabel: copy.deleteConfirm,
      cancelLabel: copy.deleteCancel,
      variant: "destructive",
    });
    if (ok) onDelete();
  }

  return (
    <li className="group flex items-center border-b border-border">
      <div className="flex-1 min-w-0 flex items-center gap-3 px-4 py-3">
        {/* Blueprint glyph — the template's own emoji if set, else a stack icon. */}
        {blueprint.icon ? (
          <span aria-hidden className="shrink-0 text-base leading-none">
            {blueprint.icon}
          </span>
        ) : (
          <FileStack
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}

        <span className="flex-1 min-w-0 flex flex-col">
          <span className="text-sm font-medium truncate">{blueprint.name}</span>
          {blueprint.description && (
            <span className="text-xs text-muted-foreground truncate">
              {blueprint.description}
            </span>
          )}
        </span>

        {/* Quiet right-side meta — section count, muted text, no box. */}
        <span className="hidden sm:inline shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {sections === 1
            ? copy.sectionsOne
            : format(copy.sectionsMany, { count: sections })}
        </span>

        {/* The one badge — "Blueprint", in the same recipe the skills row uses. */}
        <span className="hidden md:inline-block shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium border border-border bg-muted/40 text-muted-foreground">
          {copy.badge}
        </span>
      </div>

      {/* Delete — confirms through the on-brand dialog, never window.confirm. */}
      <div className="shrink-0 px-3">
        <button
          type="button"
          aria-label={format(copy.deleteAria, { name: blueprint.name })}
          title={copy.deleteTitle}
          onClick={() => void handleDelete()}
          className={cn(
            "rounded p-1 text-muted-foreground opacity-0 transition-opacity",
            "hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100",
            "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          )}
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>
    </li>
  );
}
