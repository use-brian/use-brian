/**
 * Pure policy for Electron's microphone and display-media handlers.
 *
 * Audio-only capture uses the trusted app frame as Chromium's required video
 * source, so system audio does not depend on physical screen capture starting.
 * Explicit video capture uses the confirmed screen/window. Keeping the intent,
 * trust and grant policy here makes the boundaries testable without Electron.
 *
 * [COMP:app-desktop/system-audio]
 */

export type DisplaySource = {
  display_id: string;
};

/** Tested compatibility for the affected macOS/Electron screen backend only. */
export function screenCaptureDisabledFeatures(
  platform: string, osRelease: string, electronVersion: string,
): string[] {
  return platform === "darwin" && osRelease.split(".")[0] === "25" && electronVersion === "43.2.0"
    ? ["ScreenCaptureKitMacScreen"] : [];
}

export type DisplayCaptureIntent =
  | { kind: "audio"; includeSystemAudio: true }
  | { kind: "screen" | "window"; sourceId: string; includeSystemAudio: boolean };

export function parseDisplayCaptureIntent(value: unknown): DisplayCaptureIntent {
  if (!value || typeof value !== "object") throw new Error("Invalid capture intent");
  const input = value as Record<string, unknown>;
  if (input.kind === "audio" && input.includeSystemAudio === true) {
    return { kind: "audio", includeSystemAudio: true };
  }
  if (
    (input.kind === "screen" || input.kind === "window") &&
    typeof input.sourceId === "string" && input.sourceId.length > 0 && input.sourceId.length <= 512 &&
    input.sourceId.startsWith(`${input.kind}:`) &&
    typeof input.includeSystemAudio === "boolean"
  ) {
    return { kind: input.kind, sourceId: input.sourceId, includeSystemAudio: input.includeSystemAudio };
  }
  throw new Error("Invalid capture intent");
}

/** One grant per preparation, bound to both the app window and its exact frame. */
export class CapturePreparations<Frame> {
  private prepared = new Map<number, { frame: Frame; intent: DisplayCaptureIntent }>();
  private modern = new Set<number>();

  prepare(owner: number, frame: Frame, intent: DisplayCaptureIntent): void {
    this.modern.add(owner);
    this.prepared.set(owner, { frame, intent });
  }

  take(owner: number, frame: Frame):
    | { kind: "legacy" }
    | { kind: "denied" }
    | { kind: "prepared"; intent: DisplayCaptureIntent } {
    const entry = this.prepared.get(owner);
    this.prepared.delete(owner);
    if (entry?.frame === frame) return { kind: "prepared", intent: entry.intent };
    return { kind: this.modern.has(owner) ? "denied" : "legacy" };
  }

  clear(): void {
    this.prepared.clear();
    this.modern.clear();
  }
}

/** Resolve a grant without ever enumerating a physical display for audio only. */
export async function resolveDisplayCapture<Frame, Source extends DisplaySource & { id: string }>(opts: {
  intent: DisplayCaptureIntent | { kind: "legacy"; sourceId: string | null };
  frame: Frame;
  getSources: (types: Array<"screen" | "window">) => Promise<Source[]>;
  primaryDisplayId: string | number;
}): Promise<{ video: Frame | Source; audio?: "loopback" }> {
  if (opts.intent.kind === "audio") return { video: opts.frame, audio: "loopback" };
  const intent = opts.intent;
  const sources = await opts.getSources(intent.kind === "legacy"
    ? intent.sourceId ? ["screen", "window"] : ["screen"]
    : [intent.kind]);
  const source = intent.kind === "legacy"
    ? sources.find((candidate) => candidate.id === intent.sourceId) ?? selectPrimaryDisplaySource(sources, opts.primaryDisplayId)
    : sources.find((candidate) => candidate.id === intent.sourceId);
  if (!source) throw new Error("The selected capture source is unavailable");
  return {
    video: source,
    ...(intent.kind === "legacy" || intent.includeSystemAudio ? { audio: "loopback" as const } : {}),
  };
}

export type CaptureSourceWithThumbnail = {
  id: string;
  name: string;
  thumbnail: {
    isEmpty(): boolean;
    toDataURL(): string;
  };
};

export type CaptureSourceSnapshot = {
  id: string;
  name: string;
  thumbnailDataUrl: string | null;
};

function normalizedCaptureOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "file:" ? "file://" : url.origin;
  } catch {
    return null;
  }
}

export function isTrustedCaptureOrigin(
  requestOriginOrUrl: string,
  appOrigin: string,
  allowBundledFile: boolean,
): boolean {
  const requested = normalizedCaptureOrigin(requestOriginOrUrl);
  if (allowBundledFile && requested === "file://") return true;
  const expected = normalizedCaptureOrigin(appOrigin);
  return requested !== null && expected !== null && requested === expected;
}

export function selectPrimaryDisplaySource<T extends DisplaySource>(
  sources: readonly T[],
  primaryDisplayId: string | number,
): T | undefined {
  return sources.find((source) => source.display_id === String(primaryDisplayId)) ?? sources[0];
}

/** Serialize one bounded, point-in-time source preview across the preload boundary. */
export function captureSourceSnapshot(
  source: CaptureSourceWithThumbnail,
): CaptureSourceSnapshot {
  return {
    id: source.id,
    name: source.name,
    thumbnailDataUrl: source.thumbnail.isEmpty()
      ? null
      : source.thumbnail.toDataURL(),
  };
}
