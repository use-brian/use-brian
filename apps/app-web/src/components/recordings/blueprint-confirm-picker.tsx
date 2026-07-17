"use client";

/**
 * Blueprint picker hosted INSIDE the recording pre-flight confirm dialog
 * (confirmDialog `content` slot). The pre-flight-confirm invariant requires
 * confirming BOTH cost and blueprint before the expensive transcription runs
 * (docs/architecture/engine/preflight-confirmation.md), so the picker rides
 * the same dialog on every web surface — the Studio upload button, the chat
 * dock, and the new-page landing.
 *
 * The dialog is imperative (a Promise, not a parent render), so selection
 * state lives here and is reported through `onChange` into a mutable slot the
 * `useRecordingUpload` hook reads after the user confirms. Part of
 * `[COMP:web/recording-upload]`.
 */

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import {
  SearchableSelect,
  type SearchableSelectItem,
} from "@/components/ui/searchable-select";
import { RECORDING_UNSET } from "@/lib/blueprints";

export function BlueprintConfirmPicker({
  items,
  initial,
  onChange,
}: {
  items: SearchableSelectItem[];
  initial: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  return (
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
  );
}
