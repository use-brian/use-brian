// @vitest-environment jsdom
/** [COMP:app-web/recording-chrome] authored timestamp -> editor -> visible video. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { docExtensions } from "@use-brian/doc-model";
import { RecordingPlayerBar } from "../recording-player-bar";
import { timecodeDecoration } from "@/components/doc/timecode-decoration";
import {
  RecordingPlayerProvider,
  RecordingVideoStage,
  useRecordingPlayer,
  type RecordingPlayerApi,
} from "@/lib/recordings/recording-player-context";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getRecordingMediaUrl = vi.fn();
vi.mock("@/lib/api/recordings", () => ({
  getRecordingMediaUrl: (...args: unknown[]) => getRecordingMediaUrl(...args),
}));
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));

let root: Root | null = null;
let container: HTMLDivElement;
let editor: Editor | null = null;
let player: RecordingPlayerApi;
const writeText = vi.fn();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function Probe() {
  player = useRecordingPlayer();
  return null;
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RecordingPlayerProvider recordingId="rec-video" durationMs={180_000}>
        <Probe />
        <RecordingVideoStage />
        <RecordingPlayerBar title="Product demo" />
      </RecordingPlayerProvider>,
    );
  });
}

function copyButton() {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent === en.recordings.copyTimestamp,
  )!;
}

beforeEach(() => {
  getRecordingMediaUrl.mockReset().mockResolvedValue({
    url: "https://media.example/demo.webm",
    expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    mime: "video/webm",
  });
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  editor?.destroy();
  editor = null;
  act(() => root?.unmount());
  root = null;
  container?.remove();
  vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("[COMP:app-web/recording-chrome] page timestamps", () => {
  it("copies a moment that becomes a clickable editor link seeking the same visible video", async () => {
    await mount();
    const video = container.querySelector("video")!;
    expect(video.closest(".aspect-video")).not.toBeNull();
    await act(async () => {
      video.currentTime = 83.7;
      video.dispatchEvent(new Event("timeupdate"));
    });
    await act(async () => copyButton().click());
    expect(writeText).toHaveBeenCalledWith("[0:01:23]");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(en.recordings.timestampCopied);

    // Pasting the copied text follows the normal document command path.
    // The actual decoration then drives the actual player, with only media
    // transport mocked because jsdom has no codec stack.
    const editorHost = document.createElement("div");
    container.appendChild(editorHost);
    editor = new Editor({
      element: editorHost,
      extensions: [
        ...docExtensions(),
        timecodeDecoration({
          onSeek: player.seekTo,
          hrefBase: "/w/ws-1/recordings/rec-video",
        }),
      ],
      content: "<p>Review the demo </p>",
    });
    editor.commands.insertContent(writeText.mock.calls[0][0]);
    const link = editorHost.querySelector<HTMLAnchorElement>("a[data-timecode-ms]")!;
    expect(link.textContent).toBe("[0:01:23]");
    expect(link.getAttribute("href")).toBe("/w/ws-1/recordings/rec-video#t=83");
    video.currentTime = 0;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(click, "target", { value: link });
    await act(async () => {
      editor!.view.someProp("handleClick", (handler) => handler(editor!.view, 1, click));
    });
    expect(click.defaultPrevented).toBe(true);
    expect(container.querySelector("video")).toBe(video);
    expect(video.currentTime).toBe(83);
    expect(video.play).toHaveBeenCalled();
  });

  it("keeps copying disabled until the media URL is ready", async () => {
    getRecordingMediaUrl.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(copyButton().disabled).toBe(true);
    await act(async () => copyButton().click());
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reports clipboard failure without claiming the timestamp was copied", async () => {
    writeText.mockRejectedValue(new Error("Clipboard denied"));
    await mount();
    await act(async () => copyButton().click());
    expect(container.querySelector('[role="status"]')?.textContent).toBe(en.recordings.timestampCopyFailed);
  });
});


describe("[COMP:app-web/recording-chrome] playback retry control", () => {
  it("recovers a failed source using a labelled in-place button", async () => {
    getRecordingMediaUrl.mockRejectedValueOnce(new TypeError("offline"));
    await mount();
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent === en.recordings.retryPlayback);
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(container.querySelector('[aria-label="Play"]')).not.toBeNull();
    expect(container.textContent).not.toContain(en.recordings.detailAudioError);
  });
});
