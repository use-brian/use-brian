// @vitest-environment jsdom
/**
 * [COMP:app-web/studio-wechat] WeChat connect in Studio (A12).
 *
 * "Connect my WeChat" is the default and the only mode a member sees;
 * owners/admins can also "Prepare for a staff member". Polling only reads:
 * nothing is saved until the person confirms on a card naming the signed-in
 * account and workspace. A prepared connection hands back a staff link and
 * never links the admin. Strict Mode's double mount neither kills polling nor
 * starts a second pairing. Typed refusals render their own copy.
 * Spec: docs/architecture/channels/wechat.md → "Connect flow".
 */

import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ja } from "@/lib/i18n/dictionaries/ja";
import { zh } from "@/lib/i18n/dictionaries/zh";
import { zhCN } from "@/lib/i18n/dictionaries/zh-cn";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  finalizeWechatPairing,
  getWechatPairingStatus,
  startWechatPairing,
  WechatPairingError,
} from "@/lib/api/channels";
import { WechatConnectTab } from "../wechat-connect";

vi.mock("@/lib/api/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/channels")>();
  return {
    ...actual,
    startWechatPairing: vi.fn(),
    getWechatPairingStatus: vi.fn(),
    finalizeWechatPairing: vi.fn(),
    submitWechatVerifyCode: vi.fn(),
  };
});
vi.mock("qrcode.react", () => ({ QRCodeSVG: ({ value }: { value: string }) => <svg data-qr={value} /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wc = en.studioPage.channels.add.wechat;
const WS = "00000000-0000-4000-a000-0000000000aa";
const CHANNEL = "00000000-0000-4000-a000-0000000000cc";

let container: HTMLDivElement;
let root: Root;

function mount(node: ReactNode, strict = false) {
  const tree = <I18nProvider locale="en" dict={en as unknown as Dictionary}>{node}</I18nProvider>;
  act(() => {
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
}

const flush = async (ms = 5) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`no button "${text}" in: ${container.textContent}`);
  return found;
}

function tab(over: Partial<Parameters<typeof WechatConnectTab>[0]> = {}) {
  return (
    <WechatConnectTab
      workspaceId={WS}
      defaultAssistantId={null}
      canPrepareForStaff={false}
      accountLabel="Alex Example"
      workspaceName="Example Co"
      onConnected={vi.fn()}
      pollMs={1}
      {...over}
    />
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(startWechatPairing).mockReset().mockResolvedValue({ pairingId: "p1", qrcodeUrl: "https://qr.example/p1", mode: "self" });
  vi.mocked(getWechatPairingStatus).mockReset();
  vi.mocked(finalizeWechatPairing).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("[COMP:app-web/studio-wechat] Connect my WeChat", () => {
  it("members see only self mode; nothing saves until they confirm the named account and workspace", async () => {
    vi.mocked(getWechatPairingStatus)
      .mockResolvedValueOnce({ status: "qr", qrcodeUrl: "https://qr.example/p1" })
      .mockResolvedValueOnce({ status: "scanned" })
      .mockResolvedValue({ status: "confirmed", mode: "self" });
    vi.mocked(finalizeWechatPairing).mockResolvedValue({
      status: "connected", mode: "self", channelId: CHANNEL, reused: false, identity: "linked", connectorError: null,
    });
    const onConnected = vi.fn();
    mount(tab({ onConnected }));
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    act(() => button(wc.startAction).click());
    await flush(20);
    expect(startWechatPairing).toHaveBeenCalledWith(WS, { mode: "self", defaultAssistantId: null });
    const confirm = container.querySelector('[data-testid="wechat-confirm"]');
    expect(confirm?.textContent).toContain("Alex Example");
    expect(confirm?.textContent).toContain("Example Co");
    expect(finalizeWechatPairing).not.toHaveBeenCalled();
    act(() => button(wc.confirmAction).click());
    await flush();
    expect(finalizeWechatPairing).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledWith(CHANNEL);
    expect(container.textContent).toContain(wc.connected);
  });

  it("Strict Mode neither kills polling nor starts a second pairing", async () => {
    vi.mocked(getWechatPairingStatus).mockResolvedValue({ status: "confirmed", mode: "self" });
    mount(tab(), true);
    act(() => button(wc.startAction).click());
    await flush(20);
    expect(startWechatPairing).toHaveBeenCalledTimes(1);
    expect(getWechatPairingStatus).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="wechat-confirm"]')).not.toBeNull();
  });

  it("owners/admins can prepare for a staff member: no link to the admin, a staff link instead", async () => {
    vi.mocked(startWechatPairing).mockResolvedValue({ pairingId: "p2", qrcodeUrl: "https://qr.example/p2", mode: "admin_prepare" });
    vi.mocked(getWechatPairingStatus).mockResolvedValue({ status: "confirmed", mode: "admin_prepare" });
    vi.mocked(finalizeWechatPairing).mockResolvedValue({
      status: "connected", mode: "admin_prepare", channelId: CHANNEL, reused: false, identity: "unlinked", connectorError: null,
    });
    mount(tab({ canPrepareForStaff: true }));
    const radios = container.querySelectorAll('[role="radio"]');
    expect(radios).toHaveLength(2);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    act(() => (radios[1] as HTMLButtonElement).click());
    act(() => button(wc.startAdminAction).click());
    await flush(20);
    expect(startWechatPairing).toHaveBeenCalledWith(WS, { mode: "admin_prepare", defaultAssistantId: null });
    expect(container.textContent).toContain(wc.confirmAdmin);
    expect(container.textContent).not.toContain("Alex Example");
    act(() => button(wc.confirmAdminAction).click());
    await flush();
    expect(container.textContent).toContain(wc.preparedTitle);
    expect(container.textContent).toContain(`/w/${WS}/studio/channels?channel=${CHANNEL}`);
  });

  it("renders the typed refusal, never a generic owner fallback", async () => {
    vi.mocked(getWechatPairingStatus).mockResolvedValue({ status: "confirmed", mode: "self" });
    vi.mocked(finalizeWechatPairing).mockRejectedValue(new WechatPairingError("binding_conflict", 409));
    mount(tab());
    act(() => button(wc.startAction).click());
    await flush(20);
    act(() => button(wc.confirmAction).click());
    await flush();
    expect(container.textContent).toContain(wc.errorBindingConflict);
    vi.mocked(startWechatPairing).mockRejectedValue(new WechatPairingError("pairing_failed", 503));
    act(() => button(wc.retry).click());
    await flush();
    expect(container.textContent).toContain(wc.errorUnavailable);
  });

  it("keeps controls touch-sized and every locale complete", () => {
    mount(tab({ canPrepareForStaff: true }));
    for (const b of container.querySelectorAll("button")) expect(b.className).toContain("min-h-11");
    for (const dict of [ja, zh, zhCN]) {
      const keys = Object.keys(en.studioPage.channels.add.wechat)
      expect(Object.keys(dict.studioPage.channels.add.wechat).sort()).toEqual([...keys].sort())
      for (const value of Object.values(dict.studioPage.channels.add.wechat)) expect(value).not.toContain("—")
    }
  });
});
