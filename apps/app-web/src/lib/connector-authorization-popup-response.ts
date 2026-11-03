/** Server-only callback document. [COMP:app-web/connector-authorization] */
import { randomBytes } from "node:crypto";
import { getServerDictionary } from "@/lib/i18n/server";
import type { ConnectorOauthState } from "@/lib/connector-oauth-state";

/** Success requires the cookie/state gate and API completion; failure grants nothing. */
export async function connectorAuthorizationPopupResponse(
  state: ConnectorOauthState,
  ok: boolean,
): Promise<Response> {
  const { dict, locale } = await getServerDictionary();
  const copy = dict.chat.pendingQuestion;
  const title = ok ? copy.connectComplete : copy.connectFailed;
  const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const scriptNonce = randomBytes(18).toString("base64");
  const payload = JSON.stringify({
    type: "connector-authorization", nonce: state.nonce,
    sessionId: state.continuation?.sessionId,
    approvalId: state.continuation?.approvalId, ok,
  }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><html lang="${escape(locale)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><body><main><h1>${escape(title)}</h1><p>${escape(copy.connectReturn)}</p></main><script nonce="${scriptNonce}">
const result = ${payload};
try { if (window.opener) window.opener.postMessage(result, window.location.origin); } catch {}
try { const channel = new BroadcastChannel('connector-authorization:' + result.nonce); channel.postMessage(result); channel.close(); } catch {}
window.close();
</script></body></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${scriptNonce}'; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}
