/**
 * [COMP:app-web/chat-activity] Chat streaming activity feed + the post-turn
 * receipt.
 *
 * Node-only vitest (no jsdom): components render via `renderToString`, so
 * assertions target the SSR output — labels, status classes, and the
 * structural rules (retried steps are never struck through; the feed hides
 * once the reply streams on a pure-text turn). Interactive toggling is
 * exercised through the `defaultExpanded` hook.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { ToolUsed } from "@sidanclaw/chat-ui";
import type { BuildEvent } from "@/lib/build-events";
import {
  ChatActivityFeed,
  ChatActivitySummary,
  formatDuration,
} from "../chat-activity";

const dict = en as unknown as Dictionary;

function wrap(node: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

const step = (
  id: string,
  text: string,
  extra?: Partial<BuildEvent>,
): BuildEvent => ({ id, kind: "step", text, toolId: id, ...extra });

const reasoning = (id: string, text: string): BuildEvent => ({
  id,
  kind: "reasoning",
  text,
});

const tool = (id: string, over?: Partial<ToolUsed>): ToolUsed => ({
  id,
  name: "webSearch",
  status: "done",
  description: `desc-${id}`,
  ...over,
});

describe("[COMP:app-web/chat-activity] formatDuration", () => {
  it("formats sub-10s with one decimal, seconds, and minutes", () => {
    expect(formatDuration(800)).toBe("0.8s");
    expect(formatDuration(3400)).toBe("3.4s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("never renders a zero for a tiny-but-real duration", () => {
    expect(formatDuration(8)).toBe("0.1s");
  });
});

describe("[COMP:app-web/chat-activity] Live feed", () => {
  it("shows the running tool's narration in the shimmer header", () => {
    const html = wrap(
      <ChatActivityFeed
        events={[step("t1", "Searching \"middle mile\"")]}
        tools={[tool("t1", { status: "running", description: 'Searching "middle mile"' })]}
        replyStreaming={false}
        startedAt={null}
      />,
    );
    expect(html).toContain("chat-shimmer-text");
    expect(html).toContain("Searching");
  });

  it("falls back to Thinking… before any activity arrives", () => {
    const html = wrap(
      <ChatActivityFeed events={[]} tools={[]} replyStreaming={false} startedAt={null} />,
    );
    expect(html).toContain(dict.chat.thinking);
  });

  it("reads Working… between tools (all steps settled, turn still open)", () => {
    const html = wrap(
      <ChatActivityFeed
        events={[step("t1", "Ran getWorkflow")]}
        tools={[tool("t1")]}
        replyStreaming={false}
        startedAt={null}
      />,
    );
    expect(html).toContain(dict.chat.toolNarration.working);
  });

  it("surfaces the research phase while no tool narration outranks it", () => {
    const html = wrap(
      <ChatActivityFeed
        events={[]}
        tools={[]}
        replyStreaming={false}
        researchPhase="starting"
        startedAt={null}
      />,
    );
    expect(html).toContain(dict.chat.researchStatus.starting);
  });

  it("never strikes a retried step through; tags it and shows the error when expanded", () => {
    const html = wrap(
      <ChatActivityFeed
        events={[step("t1", "Running proposeWorkflow")]}
        tools={[
          tool("t1", {
            status: "retried",
            errorMessage: "workflow not found",
          }),
        ]}
        replyStreaming={false}
        startedAt={null}
        defaultExpanded
      />,
    );
    expect(html).not.toContain("line-through");
    expect(html).toContain(dict.chat.activity.retried);
    expect(html).toContain("workflow not found");
  });

  it("renders reasoning rows italic in the feed", () => {
    const html = wrap(
      <ChatActivityFeed
        events={[reasoning("r1", "deciding which workflow to load")]}
        tools={[]}
        replyStreaming={false}
        startedAt={null}
      />,
    );
    expect(html).toContain("italic");
    expect(html).toContain("deciding which workflow to load");
  });

  it("settles to the Writing header once the reply streams (auto mode hides the body)", () => {
    const html = wrap(
      <ChatActivityFeed
        events={[step("t1", "Ran getWorkflow")]}
        tools={[tool("t1")]}
        replyStreaming
        startedAt={null}
      />,
    );
    expect(html).toContain(dict.chat.activity.writing);
    expect(html).not.toContain("Ran getWorkflow");
  });

  it("renders nothing for a pure-text turn once the reply streams", () => {
    const html = wrap(
      <ChatActivityFeed events={[]} tools={[]} replyStreaming startedAt={null} />,
    );
    expect(html).toBe("");
  });

  it("exposes a polite live region", () => {
    const html = wrap(
      <ChatActivityFeed events={[]} tools={[]} replyStreaming={false} startedAt={null} />,
    );
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/aria-live="polite"/);
  });
});

describe("[COMP:app-web/chat-activity] Post-turn receipt", () => {
  it("summarises duration and step count", () => {
    const html = wrap(
      <ChatActivitySummary
        tools={[tool("t1"), tool("t2"), tool("t3")]}
        durationMs={42_000}
      />,
    );
    expect(html).toContain("Worked for 42s");
    expect(html).toContain("3 steps");
  });

  it("uses the singular form for one step", () => {
    const html = wrap(
      <ChatActivitySummary tools={[tool("t1")]} durationMs={900} />,
    );
    expect(html).toContain("Worked for 0.9s");
    expect(html).toContain("1 step");
  });

  it("degrades to a bare step count for history restores (no timings)", () => {
    const html = wrap(<ChatActivitySummary tools={[tool("t1"), tool("t2")]} />);
    expect(html).toContain("2 steps");
    expect(html).not.toContain("Worked for");
  });

  it("lists step narrations with durations when expanded", () => {
    const html = wrap(
      <ChatActivitySummary
        tools={[tool("t1", { durationMs: 800 })]}
        durationMs={1200}
        defaultExpanded
      />,
    );
    expect(html).toContain("desc-t1");
    expect(html).toContain("0.8s");
  });

  it("renders nothing without steps", () => {
    const html = wrap(<ChatActivitySummary tools={[]} durationMs={5000} />);
    expect(html).toBe("");
  });
});
