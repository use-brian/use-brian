"use client";

/**
 * "Link a recording" — the on-demand picker for a page that has NO recording
 * (neither a synthesis `anchor_key` nor a manual link).
 *
 * A hand-authored page can point at any recording already in the workspace and
 * surface its player, transcript, and action items — the same chrome a
 * synthesized brief gets, but chosen rather than derived. The entry point is
 * the page ⋯ menu's "Link a recording" item (`page-header.tsx`): most doc
 * pages never link a recording, so the old always-visible empty-state button
 * under every title was noise, and the affordance now lives with the other
 * page-level actions. The doc shell mounts this picker in the chrome slot
 * only after the menu item is picked; the link itself lives in
 * `saved_views.linked_recording_id` (migration 339), and the shell resolves
 * the anchor-derived recording first, so the menu item only appears when
 * there is nothing to fall back to.
 *
 * The recording list is fetched on mount — which is still lazy: the component
 * exists only after the user asked for it, so no fetch ever rides an ordinary
 * page open. A themed `SearchableSelect`, never a native picker.
 *
 * [COMP:app-web/recording-chrome]
 */

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { listRecordings, type RecordingSummary } from "@/lib/api/recordings";
import { setPageLinkedRecording, type ViewMetadata } from "@/lib/api/views";
import { recordingTitle, formatDuration } from "@/lib/recordings/recordings-board";
import { SearchableSelect, type SearchableSelectItem } from "@/components/ui/searchable-select";

export function RecordingLinkControl({
  viewId,
  workspaceId,
  onLinked,
  onDismiss,
}: {
  viewId: string;
  workspaceId: string;
  /** The updated page metadata after a successful link — drives the chrome in. */
  onLinked: (meta: ViewMetadata) => void;
  /** Close the picker without linking (Cancel) — the shell unmounts it. */
  onDismiss: () => void;
}) {
  const t = useT();
  const [rows, setRows] = useState<RecordingSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listRecordings(workspaceId, { limit: 100 })
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Labels are derived at render so the fetch doesn't depend on the locale.
  const items: SearchableSelectItem[] = (rows ?? []).map((r) => {
    const dur = formatDuration(r.durationMs);
    return {
      value: r.recordingId,
      // Title first, duration as a quiet suffix — enough to disambiguate
      // two calls with the same name without a second column.
      label: dur
        ? `${recordingTitle(r, t.recordings.panelUntitled)} · ${dur}`
        : recordingTitle(r, t.recordings.panelUntitled),
    };
  });

  const pick = useCallback(
    async (recordingId: string) => {
      if (!recordingId) return;
      setSaving(true);
      try {
        const meta = await setPageLinkedRecording(viewId, recordingId);
        onLinked(meta);
      } catch {
        setError(true);
      } finally {
        setSaving(false);
      }
    },
    [viewId, onLinked],
  );

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
      <span className="text-sm font-medium">{t.recordings.linkTitle}</span>
      {error ? (
        <span className="text-sm text-muted-foreground">{t.recordings.linkError}</span>
      ) : (
        <SearchableSelect
          value=""
          onValueChange={(v) => void pick(v)}
          items={items}
          disabled={loading || saving}
          placeholder={loading ? t.recordings.linkLoading : t.recordings.linkPlaceholder}
          searchPlaceholder={t.recordings.linkSearchPlaceholder}
          aria-label={t.recordings.linkTitle}
          className="w-64"
          popupClassName="w-72"
        />
      )}
      <button
        type="button"
        onClick={onDismiss}
        disabled={saving}
        className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
      >
        {t.recordings.linkCancel}
      </button>
    </div>
  );
}
