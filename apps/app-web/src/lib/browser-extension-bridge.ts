/**
 * One-click pairing: hand the browser extension its relay address and pairing
 * code directly, instead of asking the user to copy two values into the popup
 * before a 10-minute token expires.
 *
 * The extension admits us through `externally_connectable` in its manifest,
 * which lists our origins; this module is the other half of that channel. The
 * messenger is injected so the decision logic is testable outside Chrome.
 *
 * The extension id is configuration, not a constant: an unpacked build gets a
 * per-machine id, and the Chrome Web Store fixes one at publish. Leaving it
 * unset simply falls back to the copy-paste flow.
 */

export type ExtensionPairResult =
  /** The extension took the credentials and is reconnecting. */
  | "paired"
  /** No extension answered — not installed, or a different build id. */
  | "not_installed"
  /** It answered and refused (origin not allowed, or a malformed request). */
  | "refused";

export type ExtensionMessenger = (extensionId: string, message: unknown) => Promise<unknown>;

export const EXTENSION_ID = process.env.NEXT_PUBLIC_BROWSER_EXTENSION_ID ?? "";

type ChromeRuntime = {
  sendMessage?: (id: string, message: unknown, cb: (response: unknown) => void) => void;
  lastError?: unknown;
};

function runtime(): ChromeRuntime | null {
  const chrome = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  return typeof chrome?.runtime?.sendMessage === "function" ? chrome.runtime : null;
}

/** Null when the page is not in a Chrome-family browser (or is server-rendered). */
export function chromeMessenger(): ExtensionMessenger | null {
  const rt = runtime();
  if (!rt) return null;
  return (extensionId, message) =>
    new Promise((resolve) => {
      rt.sendMessage?.(extensionId, message, (response) => {
        // Touching lastError is what stops Chrome logging "Unchecked
        // runtime.lastError" to the console; a missing extension answers with
        // undefined rather than throwing, which is why absence is a value here
        // and not an exception.
        void rt.lastError;
        resolve(response);
      });
    });
}

async function ask(
  send: ExtensionMessenger,
  extensionId: string,
  message: unknown,
): Promise<{ ok?: boolean } | null> {
  try {
    const response = (await send(extensionId, message)) as { ok?: boolean } | undefined | null;
    return response ?? null;
  } catch {
    return null;
  }
}

/** Is a reachable extension installed for this build id? */
export async function detectExtension(opts: {
  extensionId?: string;
  send: ExtensionMessenger | null;
}): Promise<boolean> {
  const extensionId = opts.extensionId ?? EXTENSION_ID;
  if (!extensionId || !opts.send) return false;
  const response = await ask(opts.send, extensionId, { type: "status" });
  return response?.ok === true;
}

export async function pairViaExtension(opts: {
  extensionId?: string;
  relayUrl: string;
  pairingToken: string;
  send: ExtensionMessenger | null;
}): Promise<ExtensionPairResult> {
  const extensionId = opts.extensionId ?? EXTENSION_ID;
  if (!extensionId || !opts.send) return "not_installed";
  const response = await ask(opts.send, extensionId, {
    type: "pair",
    relayUrl: opts.relayUrl,
    pairingToken: opts.pairingToken,
  });
  if (response === null) return "not_installed";
  return response.ok === true ? "paired" : "refused";
}
