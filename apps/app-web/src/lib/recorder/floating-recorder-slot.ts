"use client";

/**
 * Placement of the ONE floating record button while the global chat dock is
 * hidden.
 *
 * The record button is window chrome: the user expects it bottom-right on
 * every surface, not only where the doc dock happens to be visible. When a
 * surface hides the dock (the full-page Chat app, Feed, the Skill creator),
 * `WorkspaceChrome` mounts `FloatingRecorderHost`, which renders the floating
 * cluster off the dock's controller at desktop widths. Two seams let a
 * surface shape that without forking it:
 *
 *  - `claimFloatingRecorder()` - the surface renders the floating button
 *    itself (Feed's floating tuning dock beside its launcher, the Office
 *    editor's own fallback), so the host stands down instead of doubling it.
 *  - `useFloatingRecorderClearance(ref)` - the element is a composer that can
 *    sit in the bottom-right corner (the Chat composer bar, a docked rail
 *    composer). When it does, the button lifts to sit just above it instead
 *    of covering its Send action.
 *
 * While lifted, the host publishes `--floating-recorder-reserve` on the
 * document root; those composers' message lists pad their bottom with it so
 * the newest message scrolls clear of the button rather than under it.
 *
 * Spec: docs/architecture/media/live-capture.md -> "Sticky across surfaces".
 *
 * [COMP:app-web/dock-recorder]
 */

import { useEffect, useSyncExternalStore, type RefObject } from "react";

type Listener = () => void;

let claims = 0;
const clearances = new Set<HTMLElement>();
let clearanceVersion = 0;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Take a hold meaning "this surface renders the floating recorder itself". */
export function claimFloatingRecorder(): () => void {
  claims += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims -= 1;
    emit();
  };
}

export function isFloatingRecorderClaimed(): boolean {
  return claims > 0;
}

export function useFloatingRecorderClaimed(): boolean {
  return useSyncExternalStore(subscribe, isFloatingRecorderClaimed, () => false);
}

export function registerFloatingRecorderClearance(el: HTMLElement): () => void {
  clearances.add(el);
  clearanceVersion += 1;
  emit();
  return () => {
    if (!clearances.delete(el)) return;
    clearanceVersion += 1;
    emit();
  };
}

/** Register a bottom-docked composer the floating button must not cover. */
export function useFloatingRecorderClearance(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    return registerFloatingRecorderClearance(el);
  }, [ref, enabled]);
}

export function useFloatingRecorderClearanceVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => clearanceVersion,
    () => 0,
  );
}

export function getFloatingRecorderClearances(): HTMLElement[] {
  return [...clearances];
}

type Rect = { top: number; bottom: number; right: number; width: number; height: number };

/** The cluster's resting offset from the viewport bottom (`bottom-4`). */
export const FLOATING_RECORDER_REST_PX = 16;
/** Horizontal band the floating button occupies, measured from the right edge. */
const BUTTON_ZONE_PX = 136;
/** Vertical band the resting button occupies, measured from the bottom edge. */
const BUTTON_ZONE_HEIGHT_PX = 72;
const GAP_PX = 8;

/**
 * Bottom offset (px) that keeps the floating button clear of one composer, or
 * `null` when the composer does not reach the button's corner (hidden,
 * centered away from the right edge, or not docked at the bottom).
 */
export function floatingRecorderLift(
  rect: Rect,
  viewport: { width: number; height: number },
): number | null {
  if (rect.width === 0 || rect.height === 0) return null;
  if (rect.right <= viewport.width - BUTTON_ZONE_PX) return null;
  if (rect.bottom <= viewport.height - BUTTON_ZONE_HEIGHT_PX) return null;
  return Math.max(FLOATING_RECORDER_REST_PX, viewport.height - rect.top + GAP_PX);
}

/**
 * CSS custom property a registered composer's message list pads its bottom
 * with, so the newest message scrolls clear of a lifted button instead of
 * sitting under it. `0px` whenever the button is at rest, claimed, or hidden.
 */
export const FLOATING_RECORDER_RESERVE_VAR = "--floating-recorder-reserve";

/**
 * Space (px) the message list above a composer must reserve: the lifted
 * cluster's height plus a gap, or 0 when the button is not lifted over a
 * composer or is not displayed (height 0 below `lg`).
 */
export function floatingRecorderReserve(
  lift: number | null,
  clusterHeight: number,
): number {
  if (lift === null || clusterHeight <= 0) return 0;
  return Math.ceil(clusterHeight) + GAP_PX;
}

/** Test-only reset for the module singletons. */
export function resetFloatingRecorderSlotForTest(): void {
  claims = 0;
  clearances.clear();
  clearanceVersion = 0;
  emit();
}
