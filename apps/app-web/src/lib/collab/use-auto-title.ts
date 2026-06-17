"use client";

/**
 * The human-edit auto-title trigger (migration 218). Watches the live Yjs doc
 * the editor is bound to; once the body plaintext crosses
 * {@link AUTO_TITLE_MIN_CHARS} while the page is still on its untouched
 * placeholder name, it asks the server to generate a title once, then reflects
 * the result back into the page metadata via `onTitled`.
 *
 * Why client-observed but server-generated: the model call + cost attribution
 * live server-side, but the *signal* (the user paused after writing enough) is
 * a browser concern. The hook fires-and-forgets `requestAutoTitle`; the server
 * re-checks both the placeholder guard and the size floor authoritatively, so
 * a stale/duplicate call is a safe no-op.
 *
 * Fire-once + no churn: the effect is armed only while `nameOrigin ===
 * "placeholder"`. The moment the title becomes `"auto"` (this fired) or
 * `"user"` (a manual rename), `nameOrigin` changes, the effect re-runs, and
 * the observer detaches — so a page is auto-titled at most once and the title
 * never changes under the user as they keep typing.
 *
 * [COMP:app-web/use-auto-title]
 */

import { useEffect, useRef } from "react";
import type * as Y from "yjs";
import { yDocToPlaintext } from "@sidanclaw/doc-model";
import { requestAutoTitle } from "@/lib/api/views";

/**
 * Body plaintext length (chars) before the human trigger fires. Mirrors
 * `AUTO_TITLE_MIN_CHARS` in `@sidanclaw/core` (`doc/auto-title.ts`) — kept
 * as a local copy because core isn't browser-bundleable. The server re-checks
 * the authoritative value; this is only the "don't even bother" gate.
 */
export const AUTO_TITLE_MIN_CHARS = 500;

/**
 * Idle pause after the last edit before measuring + firing. Aligned with the
 * sync service's ~2s persistence debounce — "the user stopped typing" — so we
 * title on a natural pause, not mid-sentence, and never per-keystroke.
 */
const DEBOUNCE_MS = 2500;

/**
 * Pure gate for the human auto-title trigger — the decision the hook makes on
 * each debounced check, factored out so it's testable without a DOM/Yjs.
 * Fires only when synced, still on the placeholder name, not already in flight,
 * and the body has crossed the size floor.
 */
export function shouldRequestAutoTitle(params: {
  nameOrigin: string;
  synced: boolean;
  plaintextLength: number;
  inFlight: boolean;
}): boolean {
  return (
    params.synced &&
    params.nameOrigin === "placeholder" &&
    !params.inFlight &&
    params.plaintextLength >= AUTO_TITLE_MIN_CHARS
  );
}

export function useAutoTitle(params: {
  doc: Y.Doc | null;
  viewId: string | null;
  /** Title provenance — the hook is armed only while `"placeholder"`. */
  nameOrigin: string;
  /** Don't fire before the initial snapshot lands (avoids titling an empty doc). */
  synced: boolean;
  /**
   * Reflect the committed title + suggested icon back into page metadata (no
   * REST rename). `icon` is null when the model emitted no emoji or the user
   * already had one.
   */
  onTitled: (title: string, icon: string | null) => void;
}): void {
  const { doc, viewId, nameOrigin, synced, onTitled } = params;
  const inFlight = useRef(false);
  // Keep the latest callback without re-subscribing the doc observer.
  const onTitledRef = useRef(onTitled);
  onTitledRef.current = onTitled;

  useEffect(() => {
    if (!doc || !viewId || !synced || nameOrigin !== "placeholder") return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = () => {
      if (
        !shouldRequestAutoTitle({
          nameOrigin,
          synced,
          plaintextLength: yDocToPlaintext(doc).length,
          inFlight: inFlight.current,
        })
      ) {
        return;
      }
      inFlight.current = true;
      requestAutoTitle(viewId)
        .then((r) => {
          if (r.applied && r.title) onTitledRef.current(r.title, r.icon);
        })
        // Fire-and-forget: a failure (offline, 5xx) just means no title this
        // pass. The next edit's debounce — or the AI trigger — retries while
        // the page is still "placeholder".
        .catch(() => {})
        .finally(() => {
          inFlight.current = false;
        });
    };

    const onUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, DEBOUNCE_MS);
    };

    // `update` fires on every CRDT change — local keystrokes and remote (AI)
    // ops alike. Either can push the body over the threshold.
    doc.on("update", onUpdate);
    // Also schedule one check on mount: a page reopened past the threshold,
    // or content that arrived with the initial sync, should still title.
    onUpdate();

    return () => {
      if (timer) clearTimeout(timer);
      doc.off("update", onUpdate);
    };
  }, [doc, viewId, nameOrigin, synced]);
}
