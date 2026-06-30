"use client";

// [COMP:web/block-extraction-slot]
/**
 * Authoring directive block - `kind: 'extraction_slot'`, the "/extract" block.
 *
 * Carries a blueprint section's extraction INSTRUCTION: the text that tells the
 * synthesis engine what fills this section when the blueprint runs. The section
 * heading is the nearest preceding `heading` block. This block only appears in
 * blueprint templates, never in a filled / distilled page - so it renders as a
 * muted, dashed authoring panel (an editor-time directive, not page content),
 * visually distinct from real prose.
 *
 * Two editable controls:
 *   1. `instruction` - a multi-line textarea (the "what to extract" prompt).
 *      Committed to the block on every change so it syncs through Yjs via the
 *      embed node-view's `updateBlock`.
 *   2. `outputType` - an optional shape hint (prose / list / table) chosen
 *      through the themed `Select` primitive (never a native `<select>`).
 *
 * Rendered through the embed node-view's `renderEmbed` dispatch (the same path
 * as bookmark / image / child_page) - `extraction_slot` rides the opaque
 * `embed` atom, so there is no dedicated ProseMirror node and no Yjs schema
 * change. See docs/architecture/brain/structural-synthesis.md -> "The blueprint
 * object".
 */

import { useState } from "react";
import { Sparkles } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import type { ExtractionSlotBlock } from "@/lib/api/views";

/** The three output-shape hints, in display order. `auto` clears the field. */
const OUTPUT_TYPES = ["auto", "prose", "list", "table"] as const;
type OutputChoice = (typeof OUTPUT_TYPES)[number];

type Props = {
  block: ExtractionSlotBlock;
  readOnly?: boolean;
  onChange?: (patch: Partial<ExtractionSlotBlock>) => void;
};

export function BlockExtractionSlot({ block, readOnly, onChange }: Props) {
  const t = useT().docPage.extractionSlot;
  const [instruction, setInstruction] = useState<string>(block.instruction ?? "");

  // Base UI's <SelectValue> shows the raw value unless the Root gets an items
  // map; this label map makes the trigger render human-readable, localised text.
  const outputItems: Record<OutputChoice, string> = {
    auto: t.outputAuto,
    prose: t.outputProse,
    list: t.outputList,
    table: t.outputTable,
  };

  const current: OutputChoice = block.outputType ?? "auto";

  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2.5 text-foreground">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sparkles className="size-3.5 shrink-0" aria-hidden />
        <span className="uppercase tracking-wider">{t.label}</span>
      </div>
      <textarea
        value={instruction}
        readOnly={readOnly}
        rows={Math.min(8, Math.max(2, instruction.split("\n").length))}
        aria-label={t.instructionAria}
        placeholder={t.instructionPlaceholder}
        onChange={(e) => {
          const next = e.target.value;
          setInstruction(next);
          onChange?.({ instruction: next });
        }}
        className="w-full resize-y bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60 read-only:cursor-default"
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{t.outputLabel}</span>
        <Select
          value={current}
          items={outputItems}
          disabled={readOnly}
          onValueChange={(v) => {
            if (!v) return;
            // "auto" maps back to an absent `outputType` (the engine picks the
            // shape); a concrete choice persists the enum.
            onChange?.({
              outputType: v === "auto" ? undefined : (v as ExtractionSlotBlock["outputType"]),
            });
          }}
        >
          <SelectTrigger size="sm" className="min-w-28" aria-label={t.outputLabel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {OUTPUT_TYPES.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {outputItems[choice]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
