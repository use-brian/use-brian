// @vitest-environment jsdom
/**
 * [COMP:app-web/comment-history] Page History — origin "first prompt" entry.
 *
 * New behaviour (migration 231): when a page carries an `originPrompt` — the
 * chat message that created it — History pins it read-only ABOVE the comment
 * threads, and the "no conversations yet" caption is suppressed (the panel
 * isn't empty). Without an `originPrompt`, an empty page still shows the
 * caption. The comment threads themselves are unchanged — they remain the
 * page's specific follow-up conversations below the origin entry.
 *
 * Driven via SSR of the pure `HistoryList` (no popover / floating-ui), mirroring
 * `comment-thread-list.test.tsx`'s `wrap()` approach — deterministic + offline.
 */

import { describe, expect, it } from "vitest";
import { type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { CommentThread } from "@/lib/api/comments";
import { HistoryList } from "../comment-history";

const dict = en as unknown as Dictionary;
const t = dict.comments;
const noop = () => {};

function wrap(node: ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

const thread = (over: Partial<CommentThread> = {}): CommentThread => ({
  id: "th-1",
  pageId: "p1",
  workspaceId: "ws1",
  sessionId: "s1",
  anchorKind: "human_range",
  anchorBlockId: null,
  quote: "the revenue line",
  title: null,
  resolvedAt: null,
  resolvedBy: null,
  createdBy: "u1",
  createdAt: new Date("2026-06-01T00:00:00Z").toISOString(),
  ...over,
});

describe("[COMP:app-web/comment-history] History origin prompt", () => {
  it("pins the first prompt and suppresses the empty caption when present", () => {
    const html = wrap(
      <HistoryList
        threads={[]}
        originPrompt="Build me a Q3 revenue page"
        onPick={noop}
        t={t}
      />,
    );
    expect(html).toContain(t.history.originLabel);
    expect(html).toContain("Build me a Q3 revenue page");
    // Origin entry present → the panel isn't empty, so the "no conversations"
    // caption must NOT render alongside it.
    expect(html).not.toContain(t.history.empty);
  });

  it("shows the empty caption and no origin card when there is no first prompt", () => {
    const html = wrap(
      <HistoryList threads={[]} originPrompt={null} onPick={noop} t={t} />,
    );
    expect(html).toContain(t.history.empty);
    expect(html).not.toContain(t.history.originLabel);
  });

  it("renders the origin prompt above an existing comment thread, not in place of it", () => {
    const html = wrap(
      <HistoryList
        threads={[thread()]}
        originPrompt="Build me a Q3 revenue page"
        onPick={noop}
        t={t}
      />,
    );
    expect(html).toContain(t.history.originLabel);
    expect(html).toContain("Build me a Q3 revenue page");
    // The thread quote still renders → origin entry is additive, not a swap.
    expect(html).toContain("the revenue line");
  });
});
