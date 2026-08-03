"use client";

/**
 * Bridge from the one recorder controller owned by the always-mounted global
 * chat to replacement chat chrome (currently Feed's tuning dock).
 *
 * Replacement docks rehost the controller's UI; they never create another
 * `useDockRecorder` instance. A visible replacement may also register the
 * files-only chat hand-off used by a short capture, so the resulting voice
 * turn lands in the chat the user can see. Long captures remain owned by the
 * controller and keep the unchanged recording-ingest path.
 *
 * [COMP:app-web/dock-recorder]
 */

import { useSyncExternalStore } from "react";
import type { DockRecorderApi } from "@/lib/recorder/use-dock-recorder";

type Listener = () => void;

export type DockRecorderChatTarget = {
  sendVoiceClip(fileId: string): Promise<boolean>;
  getSessionId(): string | undefined;
};

let controller: DockRecorderApi | null = null;
const controllerListeners = new Set<Listener>();
const targets = new Map<symbol, DockRecorderChatTarget>();

function emitController(): void {
  for (const listener of controllerListeners) listener();
}

export function publishDockRecorderController(api: DockRecorderApi): () => void {
  controller = api;
  emitController();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // A second dock instance may have published after this one. Its controller
    // must not be cleared by the older instance's effect cleanup.
    if (controller !== api) return;
    controller = null;
    emitController();
  };
}

export function getDockRecorderController(): DockRecorderApi | null {
  return controller;
}

function subscribeController(listener: Listener): () => void {
  controllerListeners.add(listener);
  return () => controllerListeners.delete(listener);
}

export function useGlobalDockRecorder(): DockRecorderApi | null {
  return useSyncExternalStore(
    subscribeController,
    getDockRecorderController,
    () => null,
  );
}

/**
 * Register visible replacement-chat delivery. Registrations are stack-like:
 * the most recently mounted target wins, and releasing it reveals the prior
 * one. This makes an overlapping React transition safe without a one-frame
 * hand-off to a hidden chat.
 */
export function registerDockRecorderChatTarget(
  target: DockRecorderChatTarget,
): () => void {
  const key = Symbol("dock-recorder-target");
  targets.set(key, target);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    targets.delete(key);
  };
}

function activeTarget(): DockRecorderChatTarget | null {
  const list = [...targets.values()];
  return list[list.length - 1] ?? null;
}

export function sendDockRecorderVoiceClip(
  fileId: string,
  fallback: (fileId: string) => Promise<boolean>,
): Promise<boolean> {
  const target = activeTarget();
  return target ? target.sendVoiceClip(fileId) : fallback(fileId);
}

export function getDockRecorderSessionId(
  fallback: () => string | undefined,
): string | undefined {
  return activeTarget()?.getSessionId() ?? fallback();
}

/** Test-only reset for the module singleton. */
export function resetDockRecorderBridgeForTest(): void {
  controller = null;
  targets.clear();
  emitController();
}
