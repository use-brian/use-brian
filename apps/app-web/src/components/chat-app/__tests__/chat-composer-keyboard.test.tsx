// @vitest-environment jsdom
/**
 * [COMP:chat-ui/chat-composer] Host keyboard interception.
 *
 * Autocomplete hosts must be able to consume Enter before the headless
 * composer's default Enter-to-send behavior runs.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatComposer } from "@use-brian/chat-ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(props: {
  onSend: () => void;
  onAsk?: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ChatComposer
        value="@Br"
        onChange={() => {}}
        onSend={props.onSend}
        onAsk={props.onAsk}
        onKeyDown={props.onKeyDown}
      />,
    );
  });
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("chat composer textarea was not rendered");
  return textarea;
}

async function pressEnter(
  textarea: HTMLTextAreaElement,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {},
) {
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...modifiers,
      }),
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:chat-ui/chat-composer] host keyboard interception", () => {
  it("does not submit when an autocomplete consumes Enter", async () => {
    const onSend = vi.fn();
    const textarea = await mount({
      onSend,
      onKeyDown: (event) => event.preventDefault(),
    });

    await pressEnter(textarea);

    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the default Enter-to-send behavior when the host does not consume it", async () => {
    const onSend = vi.fn();
    const textarea = await mount({ onSend });

    await pressEnter(textarea);

    expect(onSend).toHaveBeenCalledOnce();
  });
});

describe("[COMP:chat-ui/chat-composer] Accel+Enter asks in a room", () => {
  it.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ] as const)("routes %s+Enter to onAsk, leaving plain Enter as the post", async (_name, modifier) => {
    const onSend = vi.fn();
    const onAsk = vi.fn();
    const textarea = await mount({ onSend, onAsk });

    await pressEnter(textarea, modifier);
    expect(onAsk).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();

    await pressEnter(textarea);
    expect(onSend).toHaveBeenCalledOnce();
    expect(onAsk).toHaveBeenCalledOnce();
  });

  it("falls back to an ordinary send where the host wires no ask", async () => {
    const onSend = vi.fn();
    const textarea = await mount({ onSend });

    await pressEnter(textarea, { metaKey: true });

    expect(onSend).toHaveBeenCalledOnce();
  });
});
