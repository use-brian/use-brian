// @vitest-environment jsdom
/**
 * [COMP:app-web/studio-custom-channel] Custom channel — bridge state card.
 *
 * The card renders what the bridge last published (`GET …/custom/state`)
 * and the API's liveness view of it. These tests pin the contract in
 * docs/architecture/channels/custom-channel.md → "Studio UI": a `needs_action`
 * state with a QR `imageDataUrl` renders an <img>; a QR `url` with no image
 * renders a client-side QR; "bridge offline" shows whenever `online` is false
 * regardless of the published status; an `input` action renders a field whose
 * submit POSTs `{ requestId, value }` and clears; a never-reported bridge is
 * shown as connecting + offline; and the one-time token reveal picks the
 * per-kind quickstart by `kind`.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Channel, CustomChannelState } from "@/lib/api/channels";
import {
  getCustomChannelState,
  submitCustomChannelInput,
} from "@/lib/api/channels";
import { BridgeTokenReveal, CustomBridgeSection } from "../page";

vi.mock("@/lib/api/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/channels")>();
  return {
    ...actual,
    getCustomChannelState: vi.fn(),
    submitCustomChannelInput: vi.fn(),
    rotateCustomChannelToken: vi.fn(),
    disconnectCustomChannel: vi.fn(),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let host: HTMLDivElement;
let root: Root;

const channel: Channel = {
  id: "channel_custom_1",
  workspaceId: "workspace_1",
  channelType: "custom",
  clearance: "internal",
  enabledCapabilities: ["chat"],
  status: "active",
  displayName: "Office bridge",
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  integrationId: "integration_1",
  config: null,
};

const baseState: CustomChannelState = {
  status: "connected",
  message: null,
  accountLabel: null,
  action: null,
  bridgeVersion: null,
  lastSeenAt: "2026-08-19T00:00:00.000Z",
  online: true,
  outboxDepth: 0,
};

function localized(node: ReactNode): ReactNode {
  return (
    <I18nProvider locale="en" dict={en}>
      {node}
    </I18nProvider>
  );
}

async function renderSection(state: CustomChannelState): Promise<void> {
  vi.mocked(getCustomChannelState).mockResolvedValue(state);
  await act(async () => {
    root.render(
      localized(<CustomBridgeSection workspaceId="workspace_1" channel={channel} />),
    );
  });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const c = en.studioPage.channels.custom;

describe("[COMP:app-web/studio-custom-channel] Custom bridge state card", () => {
  it("polls the state route for the channel on mount", async () => {
    await renderSection(baseState);
    expect(getCustomChannelState).toHaveBeenCalledWith("workspace_1", "channel_custom_1");
    expect(host.textContent).toContain(c.status.connected);
    expect(host.textContent).toContain(c.online);
    expect(host.textContent).not.toContain(c.offline);
  });

  it("renders a needs_action QR imageDataUrl as an <img> with the message", async () => {
    await renderSection({
      ...baseState,
      status: "needs_action",
      message: "Scan the QR with WeChat on your phone",
      action: { kind: "qr", imageDataUrl: "data:image/png;base64,AAAA" },
    });
    const img = host.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(host.querySelector("svg")).toBeNull();
    expect(host.textContent).toContain(c.status.needs_action);
    expect(host.textContent).toContain("Scan the QR with WeChat on your phone");
  });

  it("renders a QR url as a client-side QR when there is no image", async () => {
    await renderSection({
      ...baseState,
      status: "needs_action",
      action: { kind: "qr", url: "https://login.example/qr/abc" },
    });
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("svg")).not.toBeNull();
  });

  it("shows bridge offline whenever online is false, even for a published connected", async () => {
    await renderSection({ ...baseState, online: false });
    expect(host.textContent).toContain(c.status.connected);
    expect(host.textContent).toContain(c.offline);
  });

  it("treats a never-reported bridge as connecting + offline with the setup hint", async () => {
    await renderSection({
      ...baseState,
      status: "connecting",
      online: false,
      lastSeenAt: null,
    });
    expect(host.textContent).toContain(c.status.connecting);
    expect(host.textContent).toContain(c.offline);
    expect(host.textContent).toContain(c.neverSeen);
  });

  it("renders the input action and POSTs { requestId, value } on submit, then clears", async () => {
    vi.mocked(submitCustomChannelInput).mockResolvedValue(undefined);
    await renderSection({
      ...baseState,
      status: "needs_action",
      action: {
        kind: "input",
        prompt: "Enter the code shown on your phone",
        inputKind: "numeric",
        requestId: "req_1",
      },
    });
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Enter the code shown on your phone"]',
    );
    expect(input).not.toBeNull();
    expect(input?.getAttribute("inputmode")).toBe("numeric");

    await type(input as HTMLInputElement, " 123456 ");
    await act(async () => {
      input?.form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect(submitCustomChannelInput).toHaveBeenCalledWith(
      "workspace_1",
      "channel_custom_1",
      { requestId: "req_1", value: "123456" },
    );
    expect(input?.value).toBe("");
  });

  it("shows the account label, bridge version and outbox depth", async () => {
    await renderSection({
      ...baseState,
      accountLabel: "Ken L. (wxid_test)",
      bridgeVersion: "wechat-desktop@abc123",
      outboxDepth: 3,
    });
    expect(host.textContent).toContain("Ken L. (wxid_test)");
    expect(host.textContent).toContain("wechat-desktop@abc123");
    expect(host.textContent).toContain("3 queued for delivery");
  });
});

describe("[COMP:app-web/studio-custom-channel] Bridge token reveal", () => {
  it("shows the token once with the channel id and the wechat-desktop quickstart", async () => {
    await act(async () => {
      root.render(
        localized(
          <BridgeTokenReveal
            bridgeToken="ubc_secret"
            channelId="channel_custom_1"
            kind="wechat-desktop"
          />,
        ),
      );
    });
    const token = host.querySelector<HTMLInputElement>(
      `input[aria-label="${en.studioPage.channels.add.custom.tokenLabel}"]`,
    );
    expect(token?.value).toBe("ubc_secret");
    expect(token?.readOnly).toBe(true);
    expect(host.textContent).toContain(en.studioPage.channels.add.custom.tokenOnce);
    expect(host.textContent).toContain("channel_custom_1");
    expect(host.textContent).toContain(
      en.studioPage.channels.add.custom.kinds.wechatDesktop.step1,
    );
  });

  it("falls back to the generic bridge-path pointer for an unknown kind", async () => {
    await act(async () => {
      root.render(
        localized(
          <BridgeTokenReveal bridgeToken="ubc_secret" channelId="channel_custom_1" kind={null} />,
        ),
      );
    });
    expect(host.textContent).toContain("/bridge/v1/channels/channel_custom_1");
    expect(host.textContent).not.toContain(
      en.studioPage.channels.add.custom.kinds.wechatDesktop.step1,
    );
  });
});
