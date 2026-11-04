// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptionEditor } from "@/components/feed/caption-editor";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

let root: Root;
let host: HTMLDivElement;
let replaceDraft: (value: string) => void;
const save = vi.fn(async (_text: string) => true);

function ControlledEditor() {
  const [value, setValue] = useState("Saved draft");
  replaceDraft = setValue;
  return createElement(I18nProvider, {
    locale: "en",
    dict: en,
    children: createElement(CaptionEditor, {
      value, platform: "threads", onChange: setValue, onSave: save,
    }),
  });
}

async function type(value: string) {
  const area = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  save.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(ControlledEditor)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("[COMP:app-web/caption-editor] mounted autosave", () => {
  it("saves controlled edits after the idle window, including clearing the caption", async () => {
    await act(async () => vi.advanceTimersByTimeAsync(900));
    expect(save).not.toHaveBeenCalled();
    await type("Updated draft");
    await act(async () => vi.advanceTimersByTimeAsync(899));
    expect(save).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(save.mock.calls).toEqual([["Updated draft"]]);

    await type("");
    await act(async () => vi.advanceTimersByTimeAsync(900));
    expect(save.mock.calls).toEqual([["Updated draft"], [""]]);
  });

  it("cancels a pending edit when the host replaces the draft and saves subsequent typing", async () => {
    await type("Abandoned edit");
    await act(async () => replaceDraft("Another saved draft"));
    await act(async () => vi.advanceTimersByTimeAsync(900));
    expect(host.querySelector("textarea")?.value).toBe("Another saved draft");
    expect(save).not.toHaveBeenCalled();

    await type("Edited replacement");
    await act(async () => vi.advanceTimersByTimeAsync(900));
    expect(save.mock.calls).toEqual([["Edited replacement"]]);
  });
});
