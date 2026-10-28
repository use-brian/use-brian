// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { WorkspaceContextProvider } from "@/lib/workspace-context";
import type { ViewMetadata } from "@/lib/api/views";
import { PageHeader } from "../page-header";
import { DocFindBar } from "../find-bar";
import { browserDocExtensions } from "../doc-schema";
import { docFindExtension } from "../find-in-page";

vi.mock("@/lib/collab/use-presence", () => ({ usePresence: () => [] }));
vi.mock("@/lib/api/context-scopes", () => ({ listContextProjects: vi.fn(async () => []) }));
vi.mock("@/lib/api/workspaces", () => ({ updateWorkspacePickerPreferences: vi.fn(async () => undefined) }));
vi.mock("../breadcrumb", () => ({ Breadcrumb: () => null }));
vi.mock("../presence-avatars", () => ({ PresenceAvatars: () => null }));
vi.mock("../share-dialog", () => ({ ShareDialog: () => null }));
vi.mock("../comment-history", () => ({ CommentHistory: () => null }));
vi.mock("../schedule-badge", () => ({ ScheduleBadge: () => null, ScheduleMenuSection: () => null }));
vi.mock("../page-action-buttons", () => ({ PageActionButtons: () => null, PageActionMenuItems: () => null }));
vi.mock("../page-workflow-runs", () => ({ PageWorkflowRuns: () => null, PageWorkflowRunsMenuSection: () => null }));
vi.mock("@/components/recordings/meeting-tags-panel", () => ({ MeetingTagRulesMenuItem: () => null, MeetingTagRulesDialog: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  window.history.replaceState(null, "", "/w/workspace-a/p/page-a");
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { act(() => root.unmount()); host.remove(); window.history.replaceState(null, "", "/"); });

const scope = { ownerId: "header-owner", workspaceId: "workspace-a", pageId: "page-a" };
function FindTarget() {
  const editor = useEditor({ immediatelyRender: true, editable: false, content: "<p>alpha beta alpha</p>", extensions: [...browserDocExtensions(), docFindExtension()] });
  return <><DocFindBar editor={editor} requestScope={scope} /><EditorContent editor={editor} /></>;
}

async function mount(onFind?: () => void, withEditor = false) {
  const view = { id: "page-a", workspaceId: "workspace-a", name: "Fictional notes", state: "draft", fullWidth: false, clearance: "internal" } as ViewMetadata;
  await act(async () => root.render(
    <I18nProvider locale="en" dict={en}>
      <WorkspaceContextProvider value={{ workspaceId: view.workspaceId, name: "Fictional workspace", role: "member", clearance: "internal", me: { id: "viewer-a" } }}>
        <PageHeader view={view} breadcrumb={[]} teamspace={null} provider={null} status="connected" synced
          onNavigate={vi.fn()} onMutated={vi.fn()} onDeleted={vi.fn()} onRenameValue={vi.fn()} onDuplicate={vi.fn()}
          fullWidth={false} onToggleFullWidth={vi.fn()} memberClearance="internal" onChangeClearance={vi.fn()}
          currentUser={{ id: "viewer-a", name: "Fictional reader" }} onFind={onFind} />
        {withEditor ? <FindTarget /> : null}
      </WorkspaceContextProvider>
    </I18nProvider>,
  ));
}

async function openMore() {
  const trigger = host.querySelector<HTMLButtonElement>(`[aria-label="${en.docPage.headerMoreAria}"]`)!;
  await act(async () => trigger.click());
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
  return trigger;
}

function findItem() {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === en.docPage.find.label);
}

describe("[COMP:app-web/page-header] Find menu entry", () => {
  it("opens the existing localized Find action and closes the real menu", async () => {
    const onFind = vi.fn();
    await mount(onFind);
    const trigger = await openMore();
    expect(findItem()).toBeDefined();
    await act(async () => findItem()!.click());
    expect(onFind).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
  });

  it("does not offer Find when this header has no searchable editor", async () => {
    await mount();
    await openMore();
    expect(findItem()).toBeUndefined();
  });

  it("hands focus from the closing real menu to the real read-only Find bar", async () => {
    await mount(() => window.dispatchEvent(new CustomEvent("doc:find-open", { detail: scope })), true);
    await openMore();
    expect(findItem()).toBeDefined();
    await act(async () => findItem()!.click());
    await vi.waitFor(() => {
      const input = host.querySelector('[role="search"] input');
      expect(input).not.toBeNull();
      expect(document.activeElement).toBe(input);
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
