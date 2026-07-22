// @vitest-environment jsdom
/**
 * [COMP:app-web/share-dialog] Read-only public renderer — `[H:MM:SS]` citation
 * chips.
 *
 * The editor linkifies citations with a ProseMirror decoration; the anonymous
 * shared page has no ProseMirror, so `ReadOnlyPageBlocks` parses each text run
 * with the SAME shared scanner (`scanStamps`) at render. Asserted here:
 *   - `timecodeSegments` — the pure split (single stamp, multi-moment group,
 *     impossible stamp stays prose);
 *   - SSR inside a `RecordingPlayerProvider` WITH a recording → `.doc-timecode`
 *     anchors with the `#t=<seconds>` href;
 *   - SSR with NO recording (no provider) → the same text renders as plain
 *     prose, no anchors — inert by construction, never a dead link.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ReadOnlyPageBlocks, timecodeSegments } from "../read-only-page-blocks";
import { RecordingPlayerProvider } from "@/lib/recordings/recording-player-context";
import type { PublicBlock, PublicSource } from "@/lib/api/public-share";
import type { ViewPayload } from "@use-brian/views-renderer";

const source: PublicSource = { kind: "link", token: "tok" };
const emptyPayload = { a2ui: "0.8", root: { type: "container", children: [] } } as unknown as ViewPayload;

const mintNever = () => new Promise<{ url: string; expiresAt: string }>(() => {});

function renderShared(blocks: PublicBlock[], recordingId: string | null): string {
  const body = <ReadOnlyPageBlocks blocks={blocks} payload={emptyPayload} source={source} />;
  return renderToString(
    recordingId ? (
      <RecordingPlayerProvider recordingId={recordingId} mintMediaUrl={mintNever}>
        {body}
      </RecordingPlayerProvider>
    ) : (
      body
    ),
  );
}

describe("[COMP:app-web/share-dialog] timecodeSegments", () => {
  it("splits a citation out of surrounding prose with its ms", () => {
    expect(timecodeSegments("shipped at [0:47:21] today")).toEqual([
      { kind: "text", text: "shipped at " },
      { kind: "stamp", text: "[0:47:21]", ms: (47 * 60 + 21) * 1000 },
      { kind: "text", text: " today" },
    ]);
  });

  it("splits each moment of a multi-moment group into its own chip", () => {
    const segs = timecodeSegments("[0:01:24, 0:01:44]");
    const stamps = segs.filter((s) => s.kind === "stamp");
    expect(stamps).toHaveLength(2);
    expect(stamps[0]).toMatchObject({ text: "0:01:24", ms: 84_000 });
    expect(stamps[1]).toMatchObject({ text: "0:01:44", ms: 104_000 });
  });

  it("leaves an impossible stamp as plain text", () => {
    expect(timecodeSegments("at [00:85] maybe")).toEqual([
      { kind: "text", text: "at [00:85] maybe" },
    ]);
  });
});

describe("[COMP:app-web/share-dialog] ReadOnlyPageBlocks citation chips", () => {
  const blocks: PublicBlock[] = [
    { kind: "text", id: "t1", text: "Revenue is mostly B2B [0:08:47] today." },
  ];
  const richBlocks: PublicBlock[] = [
    {
      kind: "quote",
      id: "q1",
      richText: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "cited [0:01:22] inline" }] },
        ],
      },
    },
  ];

  it("renders a citation in a flat text block as a .doc-timecode anchor with the #t= href", () => {
    const html = renderShared(blocks, "rec-1");
    expect(html).toContain("doc-timecode");
    expect(html).toContain('href="#t=527"');
    expect(html).toContain("[0:08:47]");
  });

  it("renders a citation inside rich text (quote body) as a chip too", () => {
    const html = renderShared(richBlocks, "rec-1");
    expect(html).toContain("doc-timecode");
    expect(html).toContain('href="#t=82"');
  });

  it("renders the same text as plain prose when the page has no recording", () => {
    const html = renderShared(blocks, null);
    expect(html).not.toContain("doc-timecode");
    expect(html).toContain("[0:08:47]");
  });
});
