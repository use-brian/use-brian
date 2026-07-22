// @vitest-environment jsdom
/**
 * [COMP:app-web/public-recording-chrome] Shared-page recording chrome.
 *
 * SSR assertions: the anonymous chrome renders the player transport and the
 * transcript disclosure, and deliberately does NOT render the authed-only
 * affordances (action items with Confirm/Dismiss, "Open recording",
 * "Unlink") — those are brain writes / app deep-links a public viewer cannot
 * act on.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { RecordingPlayerProvider } from "@/lib/recordings/recording-player-context";
import { PublicRecordingChrome } from "../public-recording-chrome";
import type { PublicRecording, PublicSource } from "@/lib/api/public-share";

const dict = en as unknown as Dictionary;
const source: PublicSource = { kind: "site", host: "page.usebrian.ai", path: "expivotal-jul-22" };
const recording: PublicRecording = { recordingId: "rec-1", durationMs: 6_010_000, truncated: false };
const mintNever = () => new Promise<{ url: string; expiresAt: string }>(() => {});

function render(): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <RecordingPlayerProvider
        recordingId={recording.recordingId}
        durationMs={recording.durationMs}
        mintMediaUrl={mintNever}
      >
        <PublicRecordingChrome source={source} recording={recording} title="Expivotal brief" />
      </RecordingPlayerProvider>
    </I18nProvider>,
  );
}

describe("[COMP:app-web/public-recording-chrome] PublicRecordingChrome", () => {
  it("renders the player transport labeled by the page title", () => {
    const html = render();
    expect(html).toContain(en.recordings.detailPlay);
    expect(html).toContain('aria-label="Expivotal brief"');
  });

  it("renders the transcript disclosure, collapsed", () => {
    const html = render();
    expect(html).toContain(en.recordings.detailTranscript);
    expect(html).toContain('aria-expanded="false"');
  });

  it("does not render authed-only affordances (action items / open recording / unlink)", () => {
    const html = render();
    expect(html).not.toContain(en.recordings.actionItemsTitle);
    expect(html).not.toContain(en.recordings.chromeOpenRecording);
    expect(html).not.toContain(en.recordings.linkUnlink);
  });
});
