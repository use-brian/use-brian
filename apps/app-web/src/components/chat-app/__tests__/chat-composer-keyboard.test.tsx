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
        onKeyDown={props.onKeyDown}
      />,
    );
  });
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("chat composer textarea was not rendered");
  return textarea;
}

async function pressEnter(textarea: HTMLTextAreaElement) {
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
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
