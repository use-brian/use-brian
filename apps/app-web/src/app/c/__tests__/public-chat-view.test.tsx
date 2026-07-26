// @vitest-environment jsdom
/**
 * [COMP:app-web/public-chat-page] Anonymous public chat view (`/c/[token]`).
 *
 * The view must: mint + persist a localStorage visitor id, hydrate history
 * for it, send a turn through the SDK (visitor id + text, nothing else),
 * append the sanitized reply, and surface the daily-cap notice instead of
 * a message bubble when the link budget is exhausted.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

vi.mock("@/lib/api/public-chat", () => ({
  getPublicChatHistory: vi.fn().mockResolvedValue([]),
  sendPublicChatMessage: vi.fn(),
}));

import { PublicChatView } from "../[token]/public-chat-view";
import {
  getPublicChatHistory,
  sendPublicChatMessage,
} from "@/lib/api/public-chat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;
const mockHistory = vi.mocked(getPublicChatHistory);
const mockSend = vi.mocked(sendPublicChatMessage);

const META = {
  assistantName: "Ops Bot",
  assistantIconSeed: 1,
  assistantBio: null,
};

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  localStorage.clear();
  mockHistory.mockResolvedValue([]);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.clearAllMocks();
});

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        <PublicChatView token="tok_1" meta={META} />
      </I18nProvider>,
    );
  });
}

async function type(text: string) {
  const textarea = host!.querySelector("textarea")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  const form = host!.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("[COMP:app-web/public-chat-page] PublicChatView", () => {
  it("mints a stable visitor id and hydrates history with it", async () => {
    await render();
    expect(mockHistory).toHaveBeenCalledTimes(1);
    const [token, visitorId] = mockHistory.mock.calls[0];
    expect(token).toBe("tok_1");
    expect(visitorId).toBeTruthy();
    expect(localStorage.getItem("ub_chat_visitor")).toBe(visitorId);
  });

  it("sends a turn and renders the reply", async () => {
    mockSend.mockResolvedValueOnce({ ok: true, reply: "Hello **there**" });
    await render();
    await type("hi");
    await submit();

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [, visitorId, message] = mockSend.mock.calls[0];
    expect(visitorId).toBe(localStorage.getItem("ub_chat_visitor"));
    expect(message).toBe("hi");
    // User bubble + markdown-rendered assistant reply.
    expect(host!.textContent).toContain("hi");
    expect(host!.textContent).toContain("Hello there");
    expect(host!.querySelector("strong")?.textContent).toBe("there");
  });

  it("shows the daily-cap notice on link_budget_exhausted", async () => {
    mockSend.mockResolvedValueOnce({ ok: false, error: "link_budget_exhausted" });
    await render();
    await type("hi");
    await submit();

    expect(host!.textContent).toContain(dict.publicChat.dailyLimitReached);
  });
});
