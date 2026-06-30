"use client";

/**
 * Upload-recording entry point (recording-to-brain). A file picker + the upload
 * flow hook, plus an optional BLUEPRINT picker: which workspace blueprint the
 * synthesis engine fills from the transcript. Drop it into the Brain / Studio
 * surface where a workspace member can hand the brain a long call recording.
 * Neutral chrome (no blue) per the app-web design language.
 *
 * Picker selection follows the workspace-default ladder (migration 291): when
 * the workspace has a default recording blueprint set, the picker PRE-SELECTS it
 * (auto-apply). When none is set, the picker shows no silent default — a
 * placeholder prompts an explicit choice (a blueprint, or the "ingest only"
 * item). Whatever is selected is submitted verbatim: a blueprint id authors a
 * brief page; "ingest only" omits the slug (Pipeline B only). See
 * docs/plans/workspace-default-recording-blueprint.md §D3 and
 * structural-synthesis.md -> "One SearchableSelect picker appears in three places".
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { useRecordingUpload } from "@/lib/recordings/use-recording-upload";
import { listCustomPageTemplates } from "@/lib/api/views";
import { getWorkspaceDefaultBlueprint } from "@/lib/api/workspaces";
import type { CustomPageTemplateSummary } from "@sidanclaw/doc-model";
import {
  buildBlueprintPickerItems,
  initialRecordingBlueprint,
  recordingBlueprintToSlug,
  RECORDING_INGEST_ONLY,
  RECORDING_UNSET,
} from "@/lib/blueprints";
import {
  SearchableSelect,
  type SearchableSelectItem,
} from "@/components/ui/searchable-select";

export function RecordingUploadButton({
  workspaceId,
  assistantId,
}: {
  workspaceId: string;
  assistantId: string;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const { run, status, message } = useRecordingUpload(workspaceId, assistantId);
  const busy = status === "uploading" || status === "processing";

  // The chosen blueprint. Initial value follows the workspace-default ladder
  // (migration 291): pre-select the workspace default when set; else UNSET so a
  // placeholder prompts an explicit choice. Workspace blueprints are fetched
  // once; the picker lists them after the explicit "ingest only" item.
  const [blueprint, setBlueprint] = useState<string>(RECORDING_UNSET);
  const [workspaceBlueprints, setWorkspaceBlueprints] = useState<
    CustomPageTemplateSummary[]
  >([]);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    listCustomPageTemplates(workspaceId)
      .then((list) => {
        if (!cancelled) setWorkspaceBlueprints(list);
      })
      .catch(() => {
        // A roster fetch failure degrades to just the ingest-only item — non-fatal.
      });
    // Pre-select the workspace default when one is configured (auto-apply); a
    // null default leaves the picker UNSET so it prompts an explicit choice.
    getWorkspaceDefaultBlueprint(workspaceId)
      .then((ws) => {
        if (!cancelled && ws) {
          setBlueprint(initialRecordingBlueprint(ws.defaultRecordingBlueprintId));
        }
      })
      .catch(() => {
        // Non-fatal — stay UNSET (prompt a choice) if the default can't be read.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const blueprintItems = useMemo<SearchableSelectItem[]>(() => {
    const ingestOnly: SearchableSelectItem = {
      value: RECORDING_INGEST_ONLY,
      label: t.recordings.blueprintAuto,
    };
    return [ingestOnly, ...buildBlueprintPickerItems(workspaceBlueprints)];
  }, [t, workspaceBlueprints]);

  const label =
    status === "uploading"
      ? t.recordings.uploading
      : status === "processing"
        ? t.recordings.processing
        : t.recordings.uploadButton;

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            void run(f, recordingBlueprintToSlug(blueprint));
          }
          e.target.value = "";
        }}
      />

      {/* Blueprint picker — optional; defaults to ingest only / no page (Pipeline
          B). Themed SearchableSelect, never a native <select>. */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">
          {t.recordings.blueprintLabel}
        </label>
        <SearchableSelect
          value={blueprint}
          onValueChange={(v) => setBlueprint(v || RECORDING_UNSET)}
          items={blueprintItems}
          disabled={busy}
          placeholder={t.recordings.blueprintPlaceholder}
          aria-label={t.recordings.blueprintLabel}
          searchPlaceholder={t.recordings.blueprintSearchPlaceholder}
          className="max-w-xs"
          popupClassName="w-72"
        />
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="inline-flex w-fit items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        {label}
      </button>
      {message ? (
        <p
          className={
            status === "error"
              ? "text-sm text-destructive"
              : "text-sm text-muted-foreground"
          }
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
