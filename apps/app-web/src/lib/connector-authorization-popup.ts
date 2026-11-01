/** In-chat Google consent. [COMP:app-web/connector-authorization] */
import { OFFICIAL_OAUTH_SCOPES } from "@use-brian/shared";
import { buildConnectorState } from "@/lib/connector-oauth-state";
import { armConnectorOauthState } from "@/lib/oauth-state-cookie";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import type { PendingQuestionAction } from "@/lib/api/pending-questions";

export type ConnectorPopupError = "blocked" | "closed" | "failed" | "unconfigured";

// Drive requires a capability choice; never silently bypass that ceremony.
export function supportsInlineConnector(provider: string): boolean {
  return provider === "gcal" || provider === "gmail";
}

export function openConnectorAuthorization(input: {
  action: PendingQuestionAction;
  sessionId: string;
  approvalId: string;
  onComplete: () => void;
  onError: (reason: ConnectorPopupError) => void;
}): () => void {
  const noop = () => {};
  const clientId = publicRuntimeConfig().googleClientId;
  const context = new URL(input.action.connectPath, window.location.origin);
  const match = context.pathname.match(/^\/w\/([^/]+)\/studio\/connectors$/);
  if (!supportsInlineConnector(input.action.provider) || context.origin !== window.location.origin || !match) {
    input.onError("failed");
    return noop;
  }
  if (!clientId) {
    input.onError("unconfigured");
    return noop;
  }
  // Open synchronously in the click gesture so the browser can allow it.
  const popup = window.open("about:blank", "_blank", "popup,width=520,height=700");
  if (!popup) {
    input.onError("blocked");
    return noop;
  }
  let channel: BroadcastChannel | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let finished = false;
  let nonce: string;
  const dispose = () => {
    finished = true;
    window.removeEventListener("message", onMessage);
    channel?.close();
    if (timer) clearInterval(timer);
    popup.close();
  };
  const receive = (data: unknown) => {
    if (finished || !data || typeof data !== "object") return;
    const result = data as Record<string, unknown>;
    if (result.type !== "connector-authorization" || result.nonce !== nonce ||
        result.sessionId !== input.sessionId || result.approvalId !== input.approvalId ||
        typeof result.ok !== "boolean") return;
    dispose();
    if (result.ok) input.onComplete();
    else input.onError("failed");
  };
  function onMessage(event: MessageEvent) {
    if (event.origin === window.location.origin && event.source === popup) receive(event.data);
  }
  try {
    nonce = armConnectorOauthState();
    window.addEventListener("message", onMessage);
    // Google may sever window.opener through COOP; this same-origin channel
    // survives the provider round trip without depending on an opener handle.
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(`connector-authorization:${nonce}`);
      channel.onmessage = (event) => receive(event.data);
    }
    const state = buildConnectorState({
      connector: input.action.provider,
      workspaceId: decodeURIComponent(match[1]),
      nonce,
      continuation: { sessionId: input.sessionId, approvalId: input.approvalId },
      popup: true,
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${window.location.origin}/api/auth/callback/google-connector`,
      response_type: "code",
      scope: ["https://www.googleapis.com/auth/userinfo.email", ...OFFICIAL_OAUTH_SCOPES[input.action.provider]].join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
    });
    popup.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    const startedAt = Date.now();
    timer = setInterval(() => {
      // With COOP, closed can mean the handle was severed. Keep listening on
      // BroadcastChannel until the bounded timeout; the card offers retry.
      if (Date.now() - startedAt >= 15 * 60_000 || (!channel && popup.closed)) {
        dispose();
        input.onError(popup.closed ? "closed" : "failed");
      }
    }, 1000);
  } catch {
    dispose();
    input.onError("failed");
  }
  return dispose;
}
