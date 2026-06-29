// @vitest-environment jsdom
/**
 * Verifies the base-ui `Select` renders the selected page's NAME on the trigger
 * (not the raw id) when given an `items` map — the fix behind the page
 * event-source picker. If this fails, `items` is not enough and the picker
 * needs a `SelectValue` children formatter instead.
 */

import { describe, expect, it, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Tell React this is an act-capable environment (jsdom + createRoot).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

const OPTIONS = [
  { id: "11111111-1111-1111-1111-111111111111", label: "Inbox" },
  { id: "22222222-2222-2222-2222-222222222222", label: "Roadmap" },
];

describe("[COMP:app-web/workflow] page select label display", () => {
  it("shows the page name on the trigger via items (not the uuid)", () => {
    const items = OPTIONS.map((o) => ({ value: o.id, label: o.label }));
    mount(
      <Select items={items} value={OPTIONS[0].id}>
        <SelectTrigger>
          <SelectValue placeholder="Pick a page" />
        </SelectTrigger>
        <SelectContent>
          {OPTIONS.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>,
    );
    const trigger = container!.querySelector(
      '[data-slot="select-trigger"]',
    ) as HTMLElement;
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain("Inbox");
    expect(trigger.textContent).not.toContain("1111");
  });

  it("a member-id select shows the member NAME on the trigger", () => {
    const members = [
      { value: "u-aaaa-1111", label: "Jacka Leung" },
      { value: "u-bbbb-2222", label: "Sam Tan" },
    ];
    mount(
      <Select items={members} value="u-aaaa-1111">
        <SelectTrigger>
          <SelectValue placeholder="Add a member" />
        </SelectTrigger>
        <SelectContent>
          {members.map((m) => (
            <SelectItem key={m.value} value={m.value}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>,
    );
    const trigger = container!.querySelector(
      '[data-slot="select-trigger"]',
    ) as HTMLElement;
    expect(trigger.textContent).toContain("Jacka Leung");
    expect(trigger.textContent).not.toContain("u-aaaa");
  });

  it("WITHOUT items, the trigger shows the raw id (the bug)", () => {
    mount(
      <Select value={OPTIONS[0].id}>
        <SelectTrigger>
          <SelectValue placeholder="Pick a page" />
        </SelectTrigger>
        <SelectContent>
          {OPTIONS.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>,
    );
    const trigger = container!.querySelector(
      '[data-slot="select-trigger"]',
    ) as HTMLElement;
    // Documents the base-ui default: closed dropdown + no items map => raw id.
    expect(trigger.textContent).toContain("1111");
  });
});
