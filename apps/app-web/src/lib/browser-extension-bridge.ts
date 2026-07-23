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

/**
 * Module-local on purpose. Every caller reaches it through the `extensionId`
 * option's default, and anything wanting a different build passes one. An
 * export would only invite a second opinion on which extension we talk to.
 */
const EXTENSION_ID = process.env.NEXT_PUBLIC_BROWSER_EXTENSION_ID ?? "";

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

/**
 * Ask the extension to open its browser-control permission window.
 *
 * A web page can never raise Chrome's permission prompt itself:
 * `chrome.permissions.request()` is extension-only and must run inside a user
 * gesture in an extension context. So this asks the extension to open the one
 * page with a button that can. The user still clicks Allow there and then
 * accepts Chrome's own dialog; sending this grants nothing on its own.
 *
 * `already_granted` is kept distinct from `prompted` on purpose - telling
 * someone to go and allow something they already allowed is how a working
 * feature reads as broken.
 */
export type ControlPromptResult = "prompted" | "already_granted" | "not_installed";

export async function requestBrowserControl(opts: {
  extensionId?: string;
  send: ExtensionMessenger | null;
}): Promise<ControlPromptResult> {
  const extensionId = opts.extensionId ?? EXTENSION_ID;
  if (!extensionId || !opts.send) return "not_installed";
  const response = (await ask(opts.send, extensionId, { type: "request-control" })) as
    | { ok?: boolean; hasControl?: boolean }
    | null;
  if (response === null || response.ok !== true) return "not_installed";
  return response.hasControl === true ? "already_granted" : "prompted";
}

/**
 * Whether the extension currently holds the browser-control grant. `null` when
 * nothing answered — a caller must not read "no answer" as "not granted" and
 * start nagging about an install that is not there.
 */
export async function extensionHasControl(opts: {
  extensionId?: string;
  send: ExtensionMessenger | null;
}): Promise<boolean | null> {
  const extensionId = opts.extensionId ?? EXTENSION_ID;
  if (!extensionId || !opts.send) return null;
  const response = (await ask(opts.send, extensionId, { type: "status" })) as
    | { ok?: boolean; hasControl?: boolean }
    | null;
  if (response === null || response.ok !== true) return null;
  // An older extension build has no `hasControl` and held the permission from
  // install, so absence means granted — never "missing".
  return response.hasControl !== false;
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
