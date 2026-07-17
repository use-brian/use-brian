// @vitest-environment jsdom
/**
 * [COMP:app-web/chat-code-block] Per-code-block copy in chat markdown.
 *
 * The button must put the BLOCK's rendered text on the clipboard — exactly
 * what the `<pre>` shows, minus the single trailing newline every fenced
 * block parses with — and never the surrounding message's raw markdown.
 * jsdom has no clipboard, so the API is stubbed and the promise settled
 * through `act`.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import { ChatMarkdown } from "@use-brian/chat-ui";
import {
  ChatCodeBlock,
  chatMarkdownCodeComponents,
} from "../chat-code-block";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;

let root: Root | null = null;
let host: HTMLElement | null = null;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

function render(ui: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        {ui}
      </I18nProvider>,
    );
  });
}

async function clickCopy() {
  const btn = host!.querySelector<HTMLButtonElement>(
    'button[aria-label="Copy code"]',
  );
  expect(btn).not.toBeNull();
  await act(async () => {
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("[COMP:app-web/chat-code-block] ChatCodeBlock", () => {
  it("copies the block's rendered text, trailing fence newline trimmed", async () => {
    // Through the real markdown pipeline — the fenced block's inner text ends
    // with "\n" in the hast tree; the clipboard payload must not.
    render(
      <ChatMarkdown
        text={"before\n\n```md\n### Inputs\n- **Shop Name**\n```\n\nafter"}
        components={chatMarkdownCodeComponents}
      />,
    );
    await clickCopy();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      "### Inputs\n- **Shop Name**",
    );
  });

  it("flips to the copied state after a successful write", async () => {
    render(
      <ChatCodeBlock>
        <code>{"hello"}</code>
      </ChatCodeBlock>,
    );
    await clickCopy();
    expect(
      host!.querySelector('button[aria-label="Copied!"]'),
    ).not.toBeNull();
  });

  it("no-ops (no throw, no state flip) when the clipboard API is absent", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    render(
      <ChatCodeBlock>
        <code>{"hello"}</code>
      </ChatCodeBlock>,
    );
    await clickCopy();
    expect(host!.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
  });
});
