import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chromeMessenger,
  extensionHasControl,
  requestBrowserControl,
  detectExtension,
  pairViaExtension,
  type ExtensionMessenger,
} from "../browser-extension-bridge";

/**
 * [COMP:app-web/connect-browser] One-click pairing bridge.
 *
 * The three outcomes are distinguished because they need three different
 * things from the user: install it, retry, or fall back to copy-paste. The old
 * flow had only the fallback, so a user with the extension already installed
 * still copied two values against a 10-minute expiry.
 */
describe("[COMP:app-web/connect-browser] Extension pairing bridge", () => {
  const CREDS = { relayUrl: "wss://relay.example/ext", pairingToken: "pair-xyz" };
  const ID = "abcdefghijklmnopabcdefghijklmnop";

  it("pairs when the extension accepts", async () => {
    const send: ExtensionMessenger = vi.fn(async () => ({ ok: true }));
    expect(await pairViaExtension({ extensionId: ID, ...CREDS, send })).toBe("paired");
    expect(send).toHaveBeenCalledWith(ID, { type: "pair", ...CREDS });
  });

  it("reports not_installed when nothing answers", async () => {
    // Chrome resolves the callback with undefined (and sets lastError) when no
    // extension owns the id, so absence arrives as a value, not a throw.
    const send: ExtensionMessenger = async () => undefined;
    expect(await pairViaExtension({ extensionId: ID, ...CREDS, send })).toBe("not_installed");
  });

  it("reports not_installed when the messenger throws", async () => {
    const send: ExtensionMessenger = async () => {
      throw new Error("no receiving end");
    };
    expect(await pairViaExtension({ extensionId: ID, ...CREDS, send })).toBe("not_installed");
  });

  it("reports refused when the extension answers but declines", async () => {
    // Distinct from not_installed: retrying helps here, installing does not.
    const send: ExtensionMessenger = async () => ({ ok: false, error: "origin_not_allowed" });
    expect(await pairViaExtension({ extensionId: ID, ...CREDS, send })).toBe("refused");
  });

  it("falls back to copy-paste when no extension id is configured", async () => {
    const send: ExtensionMessenger = vi.fn(async () => ({ ok: true }));
    expect(await pairViaExtension({ extensionId: "", ...CREDS, send })).toBe("not_installed");
    expect(send).not.toHaveBeenCalled();
  });

  it("falls back when the browser has no extension messaging at all", async () => {
    // Firefox, Safari, or SSR: there is no `chrome.runtime` to ask.
    expect(await pairViaExtension({ extensionId: ID, ...CREDS, send: null })).toBe("not_installed");
  });

  it("never sends the pairing token to a browser it could not identify", async () => {
    const send: ExtensionMessenger = vi.fn(async () => ({ ok: true }));
    await pairViaExtension({ extensionId: "", ...CREDS, send });
    expect(send).not.toHaveBeenCalled();
  });

  it("detects a live extension without pairing it", async () => {
    const send: ExtensionMessenger = vi.fn(async () => ({ ok: true, state: "unpaired" }));
    expect(await detectExtension({ extensionId: ID, send })).toBe(true);
    expect(send).toHaveBeenCalledWith(ID, { type: "status" });
  });

  it("reports no extension when the probe goes unanswered", async () => {
    expect(await detectExtension({ extensionId: ID, send: async () => undefined })).toBe(false);
    expect(await detectExtension({ extensionId: ID, send: null })).toBe(false);
  });
});


describe("[COMP:app-web/connect-browser] Desktop browser bridge", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefers desktop over Chrome and supports status/control without an extension id", async () => {
    const browserControl = vi.fn(async () => ({ ok: true, hasControl: true }));
    const sendMessage = vi.fn();
    vi.stubGlobal("window", { usebrianDesktop: { browserControl } });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const send = chromeMessenger();
    expect(await detectExtension({ extensionId: "", send })).toBe(true);
    expect(await extensionHasControl({ extensionId: "", send })).toBe(true);
    expect(await requestBrowserControl({ extensionId: "", send })).toBe("already_granted");
    expect(browserControl.mock.calls).toEqual([[{ type: "status" }], [{ type: "status" }], [{ type: "request-control" }]]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("waits for relay-ready acknowledgement before resolving pairing", async () => {
    let ready!: (value: { ok: boolean }) => void;
    const browserControl = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { ready = resolve; }));
    vi.stubGlobal("window", { sidanclawDesktop: { browserControl } });
    const creds = { relayUrl: "wss://relay.example", pairingToken: "token" };
    const settled = vi.fn();
    const pending = pairViaExtension({ extensionId: "", ...creds, send: chromeMessenger() }).then(settled);
    await Promise.resolve();
    expect(browserControl).toHaveBeenCalledWith({ type: "pair", ...creds });
    expect(settled).not.toHaveBeenCalled();
    ready({ ok: true });
    await pending;
    expect(settled).toHaveBeenCalledWith("paired");
  });

  it("reports desktop refusal and rejection without falling back to Chrome", async () => {
    const browserControl = vi.fn().mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error("relay unavailable"));
    vi.stubGlobal("window", { usebrianDesktop: { browserControl } });
    const opts = { extensionId: "", relayUrl: "wss://relay.example", pairingToken: "token", send: chromeMessenger() };
    expect(await pairViaExtension(opts)).toBe("refused");
    expect(await pairViaExtension(opts)).toBe("not_installed");
  });

  it("keeps Chrome messaging for older shells without browserControl", async () => {
    vi.stubGlobal("window", { usebrianDesktop: {} });
    const sendMessage = vi.fn((_id, _message, cb) => cb({ ok: true }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const send = chromeMessenger();
    expect(await detectExtension({ extensionId: "extension-id", send })).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith("extension-id", { type: "status" }, expect.any(Function));
    expect(await detectExtension({ extensionId: "", send })).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
