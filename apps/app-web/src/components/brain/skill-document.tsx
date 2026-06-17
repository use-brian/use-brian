"use client";

/**
 * SkillDocument — the skill-as-a-document main column, shared by the skill
 * EDITOR page (`/w/[workspaceId]/brain/skills/[skillRowId]`) and the skill
 * CREATOR's doc stage (`skill-creator.tsx`). One controlled component so the
 * two surfaces can never drift apart visually:
 *
 *   - borderless title-as-H1 (`.doc-page-title`, same face as the doc surface)
 *   - borderless muted description subtitle
 *   - the when-to-use routing copy as a compact callout block
 *   - a quiet "Markdown" divider, then the body as md-restricted doc blocks
 *     (`SkillBodyEditor`) with the quiet char-budget counter
 *
 * Pure presentation: the host owns every field's state (the editor diffs via
 * `buildSkillPatch`; the creator's chat rail revises the same values), plus
 * validation errors and Save.
 *
 * Extracted verbatim from the editor page (brain-skill-management plan §3.3);
 * the focus affordances (`fieldUnderlineCls` / `quietFieldCls`) move here
 * with it.
 *
 * [COMP:app-web/skill-document]
 */

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import {
  SKILL_BODY_MAX_CHARS,
  SKILL_BODY_WARN_AT,
} from "@/lib/skill-markdown";
import { SkillBodyEditor } from "@/components/brain/skill-body-editor";

/** Grow a textarea to fit its content (document feel — no scrollbar inside
 *  the field, the page scrolls instead). Height resets first so shrinking
 *  edits collapse too; CSS `min-h-*` still wins under the measured height. */
function useAutosize(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}

/**
 * The document fields' shared focus affordance: a 1px hairline that slides in
 * from the left under the focused field (`focus-within`, so keyboard focus is
 * covered too), in the de-blue graphite language (token-driven, adapts in
 * dark mode). Replaces the app's global `:focus-visible` box-shadow ring,
 * which framed these borderless fields in a heavy blue halo and broke the
 * document illusion. The caret stays the primary signal (Notion-style); no
 * glow, no border, no shadow.
 */
export const fieldUnderlineCls =
  "relative after:absolute after:inset-x-0 after:bottom-0 after:h-px after:origin-left after:scale-x-0 after:bg-gradient-to-r after:from-foreground/35 after:via-foreground/15 after:to-transparent after:transition-transform after:duration-300 after:ease-out focus-within:after:scale-x-100";

/** Kill every ring source on the borderless document fields — the Tailwind
 *  outline/ring states AND the global `:focus-visible` box-shadow
 *  (`focus-visible:shadow-none` is the opt-out the globals rule documents).
 *  Only ever paired with `fieldUnderlineCls`, which is the replacement
 *  focus indicator. `block` removes the inline baseline gap so the
 *  underline hugs the field. */
export const quietFieldCls =
  "block outline-none focus:outline-none focus-visible:outline-none ring-0 focus:ring-0 focus-visible:shadow-none";

type Props = {
  name: string;
  onNameChange: (v: string) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
  whenToUse: string;
  onWhenToUseChange: (v: string) => void;
  content: string;
  onContentChange: (v: string) => void;
};

export function SkillDocument({
  name,
  onNameChange,
  description,
  onDescriptionChange,
  whenToUse,
  onWhenToUseChange,
  content,
  onContentChange,
}: Props) {
  const t = useT();
  const skillsCopy = t.brainPage.skills;
  const copy = t.brainPage.skillEditor;

  const whenRef = useRef<HTMLTextAreaElement | null>(null);
  useAutosize(whenRef, whenToUse);

  return (
    <>
      <div className={fieldUnderlineCls}>
        <input
          type="text"
          value={name}
          maxLength={100}
          placeholder={copy.titlePlaceholder}
          onChange={(e) => onNameChange(e.target.value)}
          aria-label={skillsCopy.createNameLabel}
          className={cn(
            "doc-page-title w-full border-0 bg-transparent p-0 text-3xl font-bold leading-tight text-foreground placeholder:text-muted-foreground/40",
            quietFieldCls,
          )}
        />
      </div>
      <div className={cn(fieldUnderlineCls, "mt-1.5")}>
        <input
          type="text"
          value={description}
          maxLength={250}
          placeholder={copy.descriptionPlaceholder}
          onChange={(e) => onDescriptionChange(e.target.value)}
          aria-label={skillsCopy.createDescriptionLabel}
          className={cn(
            "w-full border-0 bg-transparent p-0 text-base text-muted-foreground placeholder:text-muted-foreground/40",
            quietFieldCls,
          )}
        />
      </div>

      {/* When-to-use — the routing copy, visually distinct from the body.
          Focus response: the container eases a shade deeper, the label
          lifts toward foreground, and the shared underline slides in
          under the textarea. */}
      <div className="group mt-5 rounded-md bg-muted/40 px-3 py-2.5 transition-colors duration-200 focus-within:bg-muted/60">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors duration-200 group-focus-within:text-foreground/70">
          {skillsCopy.createWhenToUseLabel}
        </div>
        <div className={cn(fieldUnderlineCls, "mt-1")}>
          <textarea
            ref={whenRef}
            value={whenToUse}
            rows={1}
            placeholder={skillsCopy.createWhenToUsePlaceholder}
            onChange={(e) => onWhenToUseChange(e.target.value)}
            aria-label={skillsCopy.createWhenToUseLabel}
            className={cn(
              "w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/50",
              quietFieldCls,
            )}
          />
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <div className="h-px flex-1 bg-border/60" aria-hidden />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/50">
          {copy.markdownHint}
        </span>
      </div>

      {/* The body as doc blocks — md-restricted Tiptap over the same
          `content` draft string, so the diff/Save flow is unchanged. */}
      <div className="mt-3">
        <SkillBodyEditor
          value={content}
          onChange={onContentChange}
          placeholder={skillsCopy.createContentPlaceholder}
          ariaLabel={skillsCopy.createContentLabel}
        />
      </div>
      {/* Quiet budget counter — appears near the cap; Save blocks past it. */}
      {content.length > SKILL_BODY_WARN_AT && (
        <p
          className={cn(
            "mt-1 text-right text-[11px] tabular-nums",
            content.length > SKILL_BODY_MAX_CHARS
              ? "text-red-500"
              : "text-muted-foreground",
          )}
        >
          {format(copy.charCount, {
            count: content.length,
            max: SKILL_BODY_MAX_CHARS,
          })}
        </p>
      )}
    </>
  );
}
