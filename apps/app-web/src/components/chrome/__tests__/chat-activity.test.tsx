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
import type { ToolUsed } from "@use-brian/chat-ui";
import type { BuildEvent } from "@/lib/build-events";
import {
  ChatActivityFeed,
  ChatActivitySummary,
  ChatCitationList,
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

  it("never strikes an errored step through; tags it Failed when nothing followed, Retried when the tool ran again", () => {
    const failedHtml = wrap(
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
    expect(failedHtml).not.toContain("line-through");
    expect(failedHtml).toContain(dict.chat.activity.failed);
    expect(failedHtml).not.toContain(dict.chat.activity.retried);
    expect(failedHtml).toContain("workflow not found");

    const retriedHtml = wrap(
      <ChatActivityFeed
        events={[step("t1", "Running proposeWorkflow"), step("t2", "Running proposeWorkflow")]}
        tools={[
          tool("t1", { status: "retried", errorMessage: "workflow not found" }),
          tool("t2", { status: "done" }),
        ]}
        replyStreaming={false}
        startedAt={null}
        defaultExpanded
      />,
    );
    expect(retriedHtml).toContain(dict.chat.activity.retried);
    expect(retriedHtml).not.toContain(dict.chat.activity.failed);
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

  it.each(["saving", "finishing"] as const)("shows a static %s status after text generation, even for a plain reply", (replyPhase) => {
    const html = wrap(<ChatActivityFeed events={[]} tools={[]} replyStreaming replyPhase={replyPhase} startedAt={null} />);
    expect(html).toContain(replyPhase === "saving" ? dict.chat.activity.savingReply : dict.chat.activity.finishingReply);
    expect(html).not.toContain("chat-shimmer-text");
    expect(html).not.toContain(dict.chat.activity.writing);
  });

  it("exposes a polite live region", () => {
    const html = wrap(
      <ChatActivityFeed events={[]} tools={[]} replyStreaming={false} startedAt={null} />,
    );
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/aria-live="polite"/);
  });
});

describe("[COMP:app-web/chat-activity] Live feed parity", () => {
  it("names the running call's argument in the header and makes rows with input or output disclosable", () => {
    const html = wrap(
      <ChatActivityFeed
        events={[step("t1", "Using shopifyListOrders (shopify)")]}
        tools={[
          tool("t1", {
            name: "mcp_call",
            status: "running",
            description: "Using shopifyListOrders (shopify)",
            detail: "query: name:#1042",
            input: { server: "shopify", tool: "shopifyListOrders", args: { query: "name:#1042" } },
          }),
        ]}
        replyStreaming={false}
        startedAt={null}
        defaultExpanded
      />,
    );
    expect(html).toContain("Using shopifyListOrders (shopify) · query: name:#1042");
    expect(html).toContain('aria-label="Show details"');
  });
});

describe("[COMP:app-web/chat-activity] Post-turn receipt", () => {
  const shopify = (id: string, query: string, over?: Partial<ToolUsed>): ToolUsed => ({
    id,
    name: "mcp_call",
    status: "done",
    description: "Using shopifyListOrders (shopify)",
    detail: `query: ${query}`,
    input: { server: "shopify", tool: "shopifyListOrders", args: { query } },
    ...over,
  });

  it("summarises the run by kind with the duration, never a bare step count", () => {
    const html = wrap(
      <ChatActivitySummary
        tools={[
          tool("s1", { name: "mcp_search", description: 'Searching tools: "orders"' }),
          shopify("c1", "name:#1042"),
          shopify("c2", "name:1042"),
        ]}
        durationMs={42_000}
      />,
    );
    expect(html).toContain("Ran 2 Shopify calls and searched once · 42s");
    expect(html).not.toContain("3 steps");
  });

  it("drops the duration for history restores (no timings)", () => {
    const html = wrap(<ChatActivitySummary tools={[tool("t1"), tool("t2")]} />);
    expect(html).toContain("Searched 2 times");
    expect(html).not.toContain("·");
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

  it("folds consecutive same-tool calls into one ×N group and keeps notes as boundaries", () => {
    const html = wrap(
      <ChatActivitySummary
        tools={[shopify("c1", "name:#1042"), shopify("c2", "name:1042"), shopify("c3", "id:7")]}
        notes={[{ id: "n1", text: "Let me look that order up.", beforeToolId: "c1" }]}
        defaultExpanded
      />,
    );
    expect(html).toContain("Let me look that order up.");
    expect(html).toContain("×3");
    // Only one group header carries the shared narration; sub-rows are closed.
    expect(html.split("Using shopifyListOrders (shopify)").length - 1).toBe(1);
    expect(html).not.toContain("query: name:#1042");
  });

  it("shows the argument detail beside a lone step and marks an unfollowed failed restore as Failed", () => {
    const html = wrap(
      <ChatActivitySummary
        tools={[
          shopify("c1", "name:#1042", {
            status: "retried",
            errorMessage: "Column Not Found: order_number",
          }),
        ]}
        defaultExpanded
      />,
    );
    expect(html).toContain("query: name:#1042");
    expect(html).toContain("Column Not Found: order_number");
    expect(html).not.toContain("line-through");
    // A step with an input is a disclosure control for its details.
    expect(html).toContain('aria-label="Show details"');
    // Nothing followed the errored call, so it is a terminal failure.
    expect(html).toContain("Failed");
  });

  it("labels an errored call Retried when a later call of the same tool followed, and counts group failures", () => {
    const html = wrap(
      <ChatActivitySummary
        tools={[
          shopify("c1", "order_number:1042", { status: "retried", errorMessage: "Column Not Found" }),
          shopify("c2", "name:#1042"),
        ]}
        defaultExpanded
      />,
    );
    expect(html).toContain("×2");
    expect(html).toContain("1 failed");
    expect(html).not.toContain(">Failed<");
  });

  it("shows a closed Thinking disclosure for a live turn's reasoning", () => {
    const html = wrap(
      <ChatActivitySummary
        tools={[tool("t1")]}
        reasoning="I should look this up first."
        defaultExpanded
      />,
    );
    expect(html).toContain("Thinking");
    expect(html).not.toContain("I should look this up first.");
    const restored = wrap(<ChatActivitySummary tools={[tool("t1")]} defaultExpanded />);
    expect(restored).not.toContain("Thinking");
  });

  it("renders nothing without steps", () => {
    const html = wrap(<ChatActivitySummary tools={[]} durationMs={5000} />);
    expect(html).toBe("");
  });
});

describe("[COMP:app-web/chat-activity] Citation list", () => {
  it("renders safe source links and caps the collapsed list", () => {
    const html = wrap(
      <ChatCitationList
        label="Sources"
        citations={[
          { url: "https://one.example/report", title: "One" },
          { url: "https://two.example/report", title: "Two" },
          { url: "https://three.example/report", title: "Three" },
          { url: "https://four.example/report", title: "Four" },
          { url: "https://five.example/report", title: "Five" },
        ]}
      />,
    );

    expect(html).toContain("Sources");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("One");
    expect(html).toContain("Four");
    expect(html).not.toContain("Five");
    expect(html).toMatch(/\+[\s\S]*1/);
  });
});
