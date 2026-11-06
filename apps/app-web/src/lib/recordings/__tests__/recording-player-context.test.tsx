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

const cache = vi.hoisted(() => ({ owner: null as any, read: vi.fn(), remove: vi.fn() }));
vi.mock("../offline-media", () => ({
  mediaOwner: () => cache.owner, ownsMedia: (owner: unknown) => owner === cache.owner,
  readOfflineMedia: cache.read, removeOfflineMedia: cache.remove, downloadOfflineMedia: vi.fn(),
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
  cache.owner = null; cache.read.mockReset().mockResolvedValue(null); cache.remove.mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
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
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    expect(getRecordingMediaUrl).toHaveBeenCalledWith("rec-1", expect.any(AbortSignal));
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


describe("[COMP:recordings/player] connection recovery", () => {
  const player = () => <RecordingPlayerProvider recordingId="rec-1"><Probe /></RecordingPlayerProvider>;
  it("retries an initial failure automatically and joins simultaneous recovery signals", async () => {
    vi.useFakeTimers();
    getRecordingMediaUrl.mockRejectedValueOnce(new TypeError("offline"));
    await mount(player()); expect(api!.error).toBeTruthy();
    await act(async () => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); });
    expect(getRecordingMediaUrl).toHaveBeenCalledTimes(2);
    expect(api!.error).toBeNull(); expect(document.querySelector("video")?.src).toContain("signed");
  });
  it("releases a stalled request, retries, and ignores its late completion", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    getRecordingMediaUrl.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await mount(player());
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(api!.isLoading).toBe(false); expect(api!.error).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api!.error).toBeNull();
    await act(async () => resolve({ url: "https://media.example/late", expiresAt: new Date(Date.now() + 360_000).toISOString() }));
    expect(document.querySelector("video")?.src).not.toContain("late");
  });
  it("recovers through backoff without an online event", async () => {
    vi.useFakeTimers(); getRecordingMediaUrl.mockRejectedValueOnce(new TypeError("reset"));
    await mount(player());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api!.error).toBeNull(); expect(getRecordingMediaUrl).toHaveBeenCalledTimes(2);
  });
  it("keeps usable media and controls after proactive refresh fails", async () => {
    vi.useFakeTimers();
    getRecordingMediaUrl.mockResolvedValueOnce({ url: "https://media.example/first", expiresAt: new Date(Date.now() + 360_000).toISOString() });
    await mount(player());
    getRecordingMediaUrl.mockRejectedValue(new TypeError("offline"));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(api!.error).toBeNull(); expect(document.querySelector("video")?.src).toBe("https://media.example/first");
  });
  it("preserves paused playhead when renewing the source", async () => {
    vi.useFakeTimers();
    getRecordingMediaUrl.mockResolvedValueOnce({ url: "https://media.example/first", expiresAt: new Date(Date.now() + 360_000).toISOString() });
    await mount(player()); const el = document.querySelector("video")!;
    el.currentTime = 42;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    el.currentTime = 0;
    await act(async () => el.dispatchEvent(new Event("loadedmetadata")));
    expect(el.currentTime).toBe(42); expect(el.play).not.toHaveBeenCalled();
  });
  it("restores a requested citation when the source arrives later", async () => {
    let resolve!: (value: unknown) => void;
    getRecordingMediaUrl.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await mount(player());
    await act(async () => api!.seekTo(17_000));
    await act(async () => resolve({ url: "https://media.example/citation", expiresAt: new Date(Date.now() + 360_000).toISOString() }));
    const el = document.querySelector("video")!;
    await act(async () => el.dispatchEvent(new Event("loadedmetadata")));
    expect(el.currentTime).toBe(17); expect(el.play).toHaveBeenCalledOnce();
  });
  it("resumes an actively playing source after URL renewal", async () => {
    vi.useFakeTimers();
    getRecordingMediaUrl.mockResolvedValueOnce({ url: "https://media.example/first", expiresAt: new Date(Date.now() + 360_000).toISOString() });
    await mount(player()); const el = document.querySelector("video")!;
    Object.defineProperty(el, "paused", { configurable: true, value: false }); el.currentTime = 12;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    el.currentTime = 0;
    await act(async () => el.dispatchEvent(new Event("loadedmetadata")));
    expect(el.currentTime).toBe(12); expect(el.play).toHaveBeenCalledOnce();
  });
  it("reloads identical signed URLs on in-place retry", async () => {
    await mount(player()); const el = document.querySelector("video")!;
    await act(async () => el.dispatchEvent(new Event("error")));
    await act(async () => api!.retry());
    expect(el.load).toHaveBeenCalledOnce(); expect(api!.error).toBeNull();
  });
  it("bounds repeated codec/storage failures rather than minting in a loop", async () => {
    vi.useFakeTimers(); await mount(player()); const el = document.querySelector("video")!;
    for (let n = 0; n < 8; n++) {
      await act(async () => el.dispatchEvent(new Event("error")));
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
    }
    expect(getRecordingMediaUrl).toHaveBeenCalledTimes(6);
    expect(api!.error).toBeTruthy();
  });
  it.each([401, 403, 404])("clears media and stops automatic retries after API %s", async status => {
    vi.useFakeTimers(); await mount(player());
    getRecordingMediaUrl.mockRejectedValue(Object.assign(new Error("rejected"), { status }));
    await act(async () => api!.retry());
    expect(document.querySelector("video")?.hasAttribute("src")).toBe(false);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(getRecordingMediaUrl).toHaveBeenCalledTimes(2);
  });
  it("ignores a late response from the previous recording", async () => {
    let resolve!: (v: unknown) => void;
    getRecordingMediaUrl.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await mount(player());
    await act(async () => root!.render(<RecordingPlayerProvider recordingId="rec-2"><Probe /></RecordingPlayerProvider>));
    await act(async () => resolve({ url: "https://media.example/old", expiresAt: new Date(Date.now() + 360_000).toISOString() }));
    expect(api!.recordingId).toBe("rec-2"); expect(document.querySelector("video")?.src).not.toContain("old");
  });
});

describe("[COMP:recordings/player] offline copy and denial races", () => {
  it("plays a local copy through network failure without restarting paused playback", async () => {
    cache.owner = { viewerId: "viewer" }; cache.read.mockResolvedValue(new Blob(["audio"], { type: "audio/wav" }));
    vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:local-audio"); static revokeObjectURL = vi.fn(); });
    getRecordingMediaUrl.mockRejectedValue(new TypeError("offline"));
    await mount(<RecordingPlayerProvider recordingId="local"><Probe /></RecordingPlayerProvider>);
    expect(document.querySelector("video")?.getAttribute("src")).toBe("blob:local-audio");
    expect(api!.error).toBeNull(); expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    act(() => root?.unmount()); root = null; vi.unstubAllGlobals();
  });
  it("does not resurrect cached media when its read finishes after an authoritative denial", async () => {
    cache.owner = { viewerId: "viewer" }; let finish!: (value: Blob) => void;
    cache.read.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    getRecordingMediaUrl.mockRejectedValue(Object.assign(new Error("Access denied"), { status: 403 }));
    await mount(<RecordingPlayerProvider recordingId="denied"><Probe /></RecordingPlayerProvider>);
    await act(async () => finish(new Blob(["audio"])));
    expect(cache.remove).toHaveBeenCalled();
    expect(document.querySelector("video")?.getAttribute("src")).toBeNull(); expect(api!.error).toBeTruthy();
  });
});
