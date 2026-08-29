// @vitest-environment jsdom
/**
 * [COMP:recordings/player] — the seek API a citation drives.
 *
 * The behaviours here are the ones that decide whether a click on `[0:47:21]`
 * actually takes you to 47:21: the URL is a time-limited bearer token that must
 * be refreshed BEFORE it expires rather than after a 403, and a seek requested
 * before the audio has loaded must be replayed rather than dropped.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getRecordingMediaUrl = vi.fn();
vi.mock("@/lib/api/recordings", () => ({
  getRecordingMediaUrl: (...a: unknown[]) => getRecordingMediaUrl(...a),
}));

import {
  RecordingPlayerProvider,
  RecordingVideoStage,
  useRecordingPlayer,
  type RecordingPlayerApi,
} from "../recording-player-context";

let root: Root | null = null;
let container: HTMLElement | null = null;
let api: RecordingPlayerApi | null = null;

function Probe() {
  api = useRecordingPlayer();
  return null;
}

async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}

beforeEach(() => {
  vi.clearAllMocks();
  api = null;
  getRecordingMediaUrl.mockResolvedValue({
    url: "https://gcs.example/signed",
    expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    mime: "audio/mp4",
    durationMs: 5_735_000,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:recordings/player] no recording", () => {
  it("is inert outside a provider — a citation must not become a dead link", async () => {
    await mount(<Probe />);
    // The default context, not a throw: a page with no recording renders its
    // `[H:MM:SS]` text as plain prose by construction.
    expect(api!.recordingId).toBeNull();
    expect(() => api!.seekTo(1000)).not.toThrow();
  });

  it("mints no URL when there is no recording", async () => {
    await mount(
      <RecordingPlayerProvider recordingId={null}>
        <Probe />
      </RecordingPlayerProvider>,
    );
    expect(getRecordingMediaUrl).not.toHaveBeenCalled();
    expect(document.querySelector("video")).toBeNull();
  });
});

describe("[COMP:recordings/player] playback URL", () => {
  it("mints the URL for the recording and mounts the audio", async () => {
    await mount(
      <RecordingPlayerProvider recordingId="rec-1">
        <Probe />
      </RecordingPlayerProvider>,
    );
    expect(getRecordingMediaUrl).toHaveBeenCalledWith("rec-1");
    expect(document.querySelector("video")?.getAttribute("src")).toBe("https://gcs.example/signed");
    expect(api!.recordingId).toBe("rec-1");
  });

  it("surfaces a mint failure instead of rendering a silently dead player", async () => {
    getRecordingMediaUrl.mockRejectedValue(new Error("403 Forbidden"));
    await mount(
      <RecordingPlayerProvider recordingId="rec-1">
        <Probe />
      </RecordingPlayerProvider>,
    );
    expect(api!.error).toContain("403");
    expect(api!.isLoading).toBe(false);
  });

  it("falls back to the stored duration before metadata loads", async () => {
    // The scrubber needs a range immediately; `recordings.duration_ms` is the
    // value the server already probed.
    await mount(
      <RecordingPlayerProvider recordingId="rec-1" durationMs={5_735_000}>
        <Probe />
      </RecordingPlayerProvider>,
    );
    expect(api!.durationMs).toBe(5_735_000);
  });
});

describe("[COMP:recordings/player] seek", () => {
  it("seeks the audio element to the requested moment", async () => {
    await mount(
      <RecordingPlayerProvider recordingId="rec-1">
        <Probe />
      </RecordingPlayerProvider>,
    );
    const el = document.querySelector("video") as HTMLVideoElement;
    // jsdom has no media stack — play() is absent, so stub it.
    el.play = vi.fn().mockResolvedValue(undefined);

    await act(async () => api!.seekTo(2_841_000));
    expect(el.currentTime).toBeCloseTo(2841, 0); // [0:47:21]
  });

  it("clamps a negative seek rather than throwing", async () => {
    await mount(
      <RecordingPlayerProvider recordingId="rec-1">
        <Probe />
      </RecordingPlayerProvider>,
    );
    const el = document.querySelector("video") as HTMLVideoElement;
    el.play = vi.fn().mockResolvedValue(undefined);
    await act(async () => api!.seekTo(-5000));
    expect(el.currentTime).toBe(0);
  });

  it("survives a rejected play() — autoplay policy must not lose the seek", async () => {
    await mount(
      <RecordingPlayerProvider recordingId="rec-1">
        <Probe />
      </RecordingPlayerProvider>,
    );
    const el = document.querySelector("video") as HTMLVideoElement;
    el.play = vi.fn().mockRejectedValue(new DOMException("NotAllowedError"));
    await act(async () => api!.seekTo(1000));
    // The seek landed; only the autoplay was refused.
    expect(el.currentTime).toBeCloseTo(1, 0);
  });

  describe("video stage", () => {
    it("portals the media element into the stage for a video mime", async () => {
      getRecordingMediaUrl.mockResolvedValue({
        url: "https://gcs.example/signed-video",
        expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
        mime: "video/webm",
        durationMs: 60_000,
      });
      await mount(
        <RecordingPlayerProvider recordingId="rec-1">
          <RecordingVideoStage />
          <Probe />
        </RecordingPlayerProvider>,
      );
      expect(api?.isVideo).toBe(true);
      const stage = container!.querySelector(".aspect-video");
      expect(stage).not.toBeNull();
      // The staged element IS the seeking element — the citation frame follows.
      expect(stage!.querySelector("video")).not.toBeNull();
      expect(document.querySelectorAll("video")).toHaveLength(1);
    });

    it("keeps the stage hidden and the element chrome-only for audio", async () => {
      await mount(
        <RecordingPlayerProvider recordingId="rec-1">
          <RecordingVideoStage />
          <Probe />
        </RecordingPlayerProvider>,
      );
      expect(api?.isVideo).toBe(false);
      expect(container!.querySelector(".aspect-video")).toBeNull();
      const el = document.querySelector("video");
      expect(el?.className).toContain("hidden");
    });
  });
});
