"use client";

/**
 * Drag-and-drop file support for the doc AI-chat surfaces. Pairs with
 * `useFileAttachments` — the host passes `att.upload` as `onFiles` and spreads
 * `dropProps` onto whatever container should accept drops (the chat panel, the
 * comment thread, the comment composer). `isDragging` drives a drop overlay.
 *
 * The enter/leave counter (so moving over child elements doesn't flicker the
 * overlay — the same pattern apps/web's chat composer uses) lives in the pure
 * `dragReducer` below, which is unit-tested without a DOM. Only drags that
 * actually carry files arm the overlay, so dragging editor blocks around never
 * triggers it.
 *
 * [COMP:app-web/file-drop]
 */

import * as React from "react";

export type DragState = { depth: number; active: boolean };
const IDLE: DragState = { depth: 0, active: false };

/**
 * Pure drag-depth state machine. `enter`/`leave` are balanced across nested
 * children (dragenter on a child fires before dragleave on the parent), so the
 * overlay only clears once the pointer has truly left the container. `reset`
 * is used on drop and as a safety clear.
 */
export function dragReducer(state: DragState, action: "enter" | "leave" | "reset"): DragState {
  switch (action) {
    case "enter":
      return { depth: state.depth + 1, active: true };
    case "leave": {
      const depth = Math.max(0, state.depth - 1);
      return { depth, active: depth > 0 };
    }
    case "reset":
      return IDLE;
  }
}

/** True when a drag actually carries files (vs. dragging text / editor blocks). */
export function carriesFiles(types: readonly string[] | undefined): boolean {
  return Array.from(types ?? []).includes("Files");
}

export type FileDropApi = {
  isDragging: boolean;
  dropProps: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
};

export function useFileDrop(
  onFiles: (files: FileList) => void,
  opts?: { disabled?: boolean },
): FileDropApi {
  const [state, dispatch] = React.useReducer(dragReducer, IDLE);
  const disabled = opts?.disabled ?? false;

  // Keep the callback in a ref so dropProps stays referentially stable.
  const onFilesRef = React.useRef(onFiles);
  onFilesRef.current = onFiles;

  const dropProps = React.useMemo(
    () => ({
      onDragEnter(e: React.DragEvent) {
        if (disabled || !carriesFiles(e.dataTransfer?.types)) return;
        e.preventDefault();
        e.stopPropagation();
        dispatch("enter");
      },
      onDragOver(e: React.DragEvent) {
        if (disabled || !carriesFiles(e.dataTransfer?.types)) return;
        // preventDefault is required for onDrop to fire.
        e.preventDefault();
        e.stopPropagation();
      },
      onDragLeave(e: React.DragEvent) {
        if (disabled || !carriesFiles(e.dataTransfer?.types)) return;
        e.preventDefault();
        e.stopPropagation();
        dispatch("leave");
      },
      onDrop(e: React.DragEvent) {
        if (disabled) return;
        e.preventDefault();
        e.stopPropagation();
        dispatch("reset");
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) onFilesRef.current(files);
      },
    }),
    [disabled],
  );

  return { isDragging: state.active, dropProps };
}
