import { describe, expect, it } from "vitest";
import { resolveChatTarget, type ChatTargetPage } from "../chat-target";

const page = (over: Partial<ChatTargetPage> = {}): ChatTargetPage => ({
  id: "p1",
  name: "Q3 Plan",
  state: "draft",
  icon: null,
  entity: "tasks",
  viewType: "table",
  nameOrigin: "placeholder",
  ...over,
});

describe("[COMP:app-web/chat-target] resolveChatTarget", () => {
  it("creates a new draft when no page is open", () => {
    expect(resolveChatTarget(null, null)).toEqual({ mode: "create" });
  });

  it("creates regardless of stale metadata when the path has no page", () => {
    // The path is the source of truth: at the /p index the next message
    // mints a draft even if `activePage` still holds a prior page.
    expect(resolveChatTarget(null, page())).toEqual({ mode: "create" });
  });

  it("edits the open page when the resolved metadata matches the target id", () => {
    const p = page({ id: "p1" });
    expect(resolveChatTarget("p1", p)).toEqual({ mode: "edit", page: p });
  });

  it("is edit-pending when a page is open but metadata hasn't resolved", () => {
    // Deep-link / direct load: id known from the path, getView() in flight.
    expect(resolveChatTarget("p1", null)).toEqual({ mode: "edit-pending" });
  });

  it("is edit-pending mid-switch when the path and metadata ids disagree", () => {
    // activePage lags one tick behind the path during a page switch; never
    // name the previous page while the message would target the new one.
    expect(resolveChatTarget("p2", page({ id: "p1" }))).toEqual({
      mode: "edit-pending",
    });
  });
});
