"use client";

/**
 * The choice panel hosted INSIDE the recording pre-flight confirm dialog
 * (confirmDialog `content` slot). The pre-flight-confirm invariant requires
 * confirming cost AND the shape of the output before the expensive
 * transcription runs (docs/architecture/engine/preflight-confirmation.md), so
 * this panel rides the same dialog on every web surface - the Studio upload
 * button, the chat dock, and the new-page landing.
 *
 * Two choices, in dependency order:
 *
 *   1. **Blueprint** - which brief to synthesize, or ingest-only.
 *   2. **Destination** - where the brief page is filed in the page tree
 *      (`nest_parent_id`). Rendered ONLY when a blueprint is selected:
 *      ingest-only authors no page, so a destination control would be dead.
 *      Before this existed every brief landed at the workspace root with no
 *      way to say otherwise.
 *
 * The dialog is imperative (a Promise, not a parent render), so selection
 * state lives here and is reported through `onChange` callbacks into mutable
 * slots the `useRecordingUpload` hook reads after the user confirms. Part of
 * `[COMP:web/recording-upload]`.
 */

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import {
  SearchableSelect,
  type SearchableSelectItem,
} from "@/components/ui/searchable-select";
import { RECORDING_INGEST_ONLY, RECORDING_UNSET } from "@/lib/blueprints";

/** Sentinel for "file at the workspace root" - the pre-picker behaviour. */
export const DESTINATION_ROOT = "__root__";

export function RecordingConfirmPicker({
  items,
  initial,
  onChange,
  destinationItems,
  initialDestination = DESTINATION_ROOT,
  onDestinationChange,
}: {
  items: SearchableSelectItem[];
  initial: string;
  onChange: (value: string) => void;
  /** Candidate parent pages. Omitted / empty → the destination row is hidden. */
  destinationItems?: SearchableSelectItem[];
  initialDestination?: string;
  onDestinationChange?: (value: string) => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const [destination, setDestination] = useState(initialDestination);

  // Ingest-only (and the not-yet-chosen state) author no page, so there is
  // nothing to file. Hiding beats disabling: a greyed control still reads as
  // "this recording will be filed somewhere", which would be a lie.
  const authorsPage = value !== RECORDING_INGEST_ONLY && value !== RECORDING_UNSET;
  const showDestination =
    authorsPage && !!onDestinationChange && (destinationItems?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">
          {t.recordings.blueprintLabel}
        </label>
        <SearchableSelect
          value={value}
          onValueChange={(v) => {
            const next = v || RECORDING_UNSET;
            setValue(next);
            onChange(next);
          }}
          items={items}
          placeholder={t.recordings.blueprintPlaceholder}
          aria-label={t.recordings.blueprintLabel}
          searchPlaceholder={t.recordings.blueprintSearchPlaceholder}
          popupClassName="w-72"
        />
      </div>

      {showDestination ? (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">
            {t.recordings.destinationLabel}
          </label>
          <SearchableSelect
            value={destination}
            onValueChange={(v) => {
              const next = v || DESTINATION_ROOT;
              setDestination(next);
              onDestinationChange?.(next);
            }}
            items={destinationItems ?? []}
            placeholder={t.recordings.destinationPlaceholder}
            aria-label={t.recordings.destinationLabel}
            searchPlaceholder={t.recordings.destinationSearchPlaceholder}
            popupClassName="w-72"
          />
        </div>
      ) : null}
    </div>
  );
}
