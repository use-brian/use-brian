"use client";

/** Destination picker hosted by the live-recording pre-flight dialog. */

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import {
  SearchableSelect,
  type SearchableSelectItem,
} from "@/components/ui/searchable-select";

export const LIVE_NEW_ROOT = "new:root";
export const liveNewUnder = (pageId: string) => `new:${pageId}`;
export const liveUseExisting = (pageId: string) => `existing:${pageId}`;

export function LiveRecordingPicker({
  items,
  initial = LIVE_NEW_ROOT,
  onChange,
}: {
  items: SearchableSelectItem[];
  initial?: string;
  onChange: (value: string) => void;
}) {
  const t = useT().recorder;
  const [value, setValue] = useState(initial);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">
        {t.liveDestinationLabel}
      </label>
      <SearchableSelect
        value={value}
        onValueChange={(next) => {
          const resolved = next || LIVE_NEW_ROOT;
          setValue(resolved);
          onChange(resolved);
        }}
        items={items}
        placeholder={t.liveDestinationLabel}
        aria-label={t.liveDestinationLabel}
        searchPlaceholder={t.liveDestinationSearch}
        popupClassName="w-80"
      />
    </div>
  );
}

