// @vitest-environment jsdom
/**
 * [COMP:app-web/slash-command-autocomplete] Visible discovery + selected mode.
 *
 * The pure test covers parsing and ranking. This DOM contract guards the UX
 * the user actually relies on: `/` produces immediate feedback while the
 * roster loads, a pick becomes an explicit command state, and dismissing that
 * state preserves the arguments already typed after the command.
 */

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "@use-brian/chat-ui";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  SlashCommandIndicator,
  SlashCommandMenuList,
  useSlashCommands,
} from "../slash-command-autocomplete";

const { listInvocableSkillsMock } = vi.hoisted(() => ({
  listInvocableSkillsMock: vi.fn(),
}));

vi.mock("@/lib/api/skills", () => ({
  listInvocableSkills: listInvocableSkillsMock,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roster = [
  { slug: "goal", name: "Goal", description: "Run a durable objective" },
  { slug: "help", name: "Help", description: "List available commands" },
];

function Harness() {
  const [value, setValue] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const commands = useSlashCommands({
    enabled: true,
    workspaceId: "workspace-1",
    value,
    onChange: setValue,
    containerRef,
  });
  return (
    <div ref={containerRef}>
      <SlashCommandMenuList commands={commands} />
      <SlashCommandIndicator commands={commands} />
      <ChatComposer
        value={value}
        onChange={setValue}
        onSend={() => {}}
        onKeyDown={commands.handleKeyDown}
        highlightRanges={commands.highlightRanges}
      />
    </div>
  );
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en as unknown as Dictionary}>
        <Harness />
      </I18nProvider>,
    );
  });
}

function input(): HTMLTextAreaElement {
  return container!.querySelector<HTMLTextAreaElement>("textarea")!;
}

async function type(text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  listInvocableSkillsMock.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/slash-command-autocomplete] visible command UX", () => {
  it("opens immediately with loading feedback, then renders the roster", async () => {
    let resolveRoster!: (value: typeof roster) => void;
    listInvocableSkillsMock.mockReturnValue(
      new Promise<typeof roster>((resolve) => {
        resolveRoster = resolve;
      }),
    );
    await mount();

    await type("/");
    expect(container!.querySelector('[role="listbox"]')).toBeTruthy();
    expect(container!.textContent).toContain("Loading commands");

    await act(async () => resolveRoster(roster));
    expect(container!.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(container!.textContent).toContain("/goal");
    expect(container!.textContent).toContain("/help");
  });

  it("keeps the lazy roster request alive while the command is typed", async () => {
    let resolveRoster!: (value: typeof roster) => void;
    listInvocableSkillsMock.mockReturnValue(
      new Promise<typeof roster>((resolve) => {
        resolveRoster = resolve;
      }),
    );
    await mount();

    await type("/");
    await type("/go");
    expect(container!.textContent).toContain("Loading commands");

    await act(async () => resolveRoster(roster));
    expect(container!.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(container!.textContent).toContain("/goal");
  });

  it("shows no-match feedback instead of silently closing", async () => {
    listInvocableSkillsMock.mockResolvedValue(roster);
    await mount();

    await type("/missing");
    await act(async () => {});

    expect(container!.querySelector('[role="listbox"]')).toBeTruthy();
    expect(container!.textContent).toContain("No matching commands");
  });

  it("turns a pick into a command strip and removes only its prefix", async () => {
    listInvocableSkillsMock.mockResolvedValue(roster);
    await mount();
    await type("/go");
    await act(async () => {});

    const goal = container!.querySelector<HTMLButtonElement>(
      '[role="option"][aria-label="Run /goal"]',
    )!;
    await act(async () => {
      goal.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });

    expect(input().value).toBe("/goal ");
    expect(
      container!.querySelector('[data-testid="slash-command-indicator"]'),
    ).toBeTruthy();
    expect(container!.textContent).toContain("Using command");
    expect(
      container!.querySelector(".composer-command-chip")?.textContent,
    ).toBe("/goal");

    await type("/goal ship the release");
    const clear = container!.querySelector<HTMLButtonElement>(
      '[aria-label="Remove /goal command"]',
    )!;
    await act(async () => clear.click());

    expect(input().value).toBe("ship the release");
    expect(
      container!.querySelector('[data-testid="slash-command-indicator"]'),
    ).toBeNull();
  });
});
