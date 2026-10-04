import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseLastCookie } from "@/lib/auth-cookies";
import { INTERNAL_API_URL } from "@/lib/internal-api-url";
import { buildDelegatedLoginUrl, primaryAuthUrl, publicAppUrl } from "@/lib/primary-auth";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isLocale, LOCALE_COOKIE, matchLocale } from "@/lib/i18n/config";

export const runtime = "nodejs";
const CALLBACK = "usebrian-mobile://auth";
const TTL = 600;
const headers = {
  "Cache-Control": "no-store",
  // Not `no-referrer`: under it browsers send `Origin: null` on the consent
  // form's same-origin POST, which the origin check below must reject.
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' usebrian-mobile:; frame-ancestors 'none'; base-uri 'none'",
};
type Transaction = { challenge: string; state: string; clientId: string };
function transaction(params: URLSearchParams): Transaction | null {
  if (["challenge", "state", "clientId"].some(key => params.getAll(key).length !== 1)) return null;
  const challenge = params.get("challenge") ?? "";
  const state = params.get("state") ?? "";
  const clientId = params.get("clientId") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || Buffer.from(challenge, "base64url").toString("base64url") !== challenge ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(state) || !["brian-ios", "brian-android"].includes(clientId)) return null;
  return { challenge, state, clientId };
}
function dictionary(request: Request) {
  const locale = parseLastCookie(request.headers.get("cookie") ?? "", LOCALE_COOKIE);
  return getDictionary(isLocale(locale) ? locale : matchLocale(request.headers.get("accept-language"))).mobileAuth;
}
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function html(body: string, status = 200) {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:0;padding:24px;color:#17202a;background:#fafafa}main{max-width:480px;margin:10dvh auto}button{font:inherit;min-height:44px;padding:12px 20px;margin:8px 8px 0 0;cursor:pointer}p{overflow-wrap:anywhere}</style></head><body><main>${body}</main></body></html>`, {
    status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
}
function error(request: Request, status: number) {
  return html(`<h1>${escape(dictionary(request).error)}</h1>`, status);
}
function token(request: Request) {
  return parseLastCookie(request.headers.get("cookie") ?? "", "access_token");
}
function login(url: URL) {
  const primary = primaryAuthUrl();
  const target = primary ? buildDelegatedLoginUrl(primary, url.toString()) :
    buildDelegatedLoginUrl(url.origin, `${url.pathname}${url.search}`);
  return new Response(null, { status: 303, headers: { ...headers, Location: target } });
}
function cookieName(url: URL) { return url.protocol === "https:" ? "__Host-mobile_auth" : "mobile_auth"; }
function setCookie(response: Response, url: URL, value: string, maxAge = TTL) {
  response.headers.set("Set-Cookie", `${cookieName(url)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${url.protocol === "https:" ? "; Secure" : ""}`);
  return response;
}
function signature(accessToken: string, tx: Transaction, nonce: string) {
  // The authenticated browser's HttpOnly bearer is a server-held secret here.
  // Bind confirmation to the exact account session AND native transaction.
  return createHmac("sha256", accessToken).update(JSON.stringify([tx, nonce])).digest("base64url");
}
function equal(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function callback(tx: Transaction, result: Record<string, string>, url: URL) {
  const location = `${CALLBACK}?${new URLSearchParams({ ...result, state: tx.state })}`;
  return setCookie(new Response(null, { status: 303, headers: { ...headers, Location: location } }), url, "", 0);
}

/**
 * GET authenticates and shows consent. It NEVER mints a code.
 * Like `/desktop/auth`, once a well-formed transaction exists every failure
 * returns to the app as `error=…` rather than stranding the browser here.
 */
export async function GET(request: Request) {
  const url = publicAppUrl(request.url);
  const tx = transaction(url.searchParams);
  if (!tx) return error(request, 400);
  const accessToken = token(request);
  if (!accessToken) return login(url);
  try {
    const account = await fetch(`${INTERNAL_API_URL}/auth/mobile/account`, {
      headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store", redirect: "error",
    });
    if (account.status === 401) return login(url);
    if (!account.ok) return callback(tx, { error: "server_error" }, url);
    const { user } = await account.json() as { user: { id: string; email: string | null; name: string | null } };
    const nonce = `${Date.now()}.${randomBytes(32).toString("base64url")}`;
    const csrf = `${nonce}.${signature(accessToken, tx, nonce)}`;
    const t = dictionary(request);
    const fields = { ...tx, csrf };
    return setCookie(html(`<h1>${escape(t.title)}</h1><p>${escape(t.description)}</p><p>${escape(user.email || user.name || user.id)}</p><p>${escape(tx.clientId === "brian-ios" ? t.ios : t.android)}</p><form method="post" action="/mobile/auth">${Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${name}" value="${escape(value)}">`).join("")}<button name="decision" value="allow" type="submit">${escape(t.confirm)}</button><button name="decision" value="deny" type="submit">${escape(t.cancel)}</button></form>`), url, csrf);
  } catch { return callback(tx, { error: "server_error" }, url); }
}

export async function POST(request: Request) {
  const url = publicAppUrl(request.url);
  const body = await request.text();
  if (body.length > 4096) return error(request, 400);
  const form = new URLSearchParams(body);
  const tx = transaction(form);
  // No well-formed transaction means no app is waiting on a state to answer.
  if (!tx) return error(request, 400);
  // A rejection carries only an error, never a code, so answering a forged
  // request gives it nothing it could not already navigate to itself.
  const reject = () => callback(tx, { error: "invalid_request" }, url);
  // Do not trust forwarded host/origin headers. Behind ingress configure AUTHED_APP_URL.
  if (request.headers.get("origin") !== url.origin ||
      request.headers.get("sec-fetch-site") === "cross-site" ||
      request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded") return reject();
  const accessToken = token(request);
  if (!accessToken) return callback(tx, { error: "login_required" }, url);
  const csrf = form.get("csrf") ?? "";
  const cookie = parseLastCookie(request.headers.get("cookie") ?? "", cookieName(url)) ?? "";
  const [timestamp, random, mac, ...extra] = csrf.split(".");
  const age = Date.now() - Number(timestamp);
  if (form.getAll("csrf").length !== 1 || form.getAll("decision").length !== 1 ||
      !/^[0-9]{13}$/.test(timestamp ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(random ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/.test(mac ?? "") || extra.length || age < 0 || age > TTL * 1000 ||
      !equal(csrf, cookie) || !equal(mac, signature(accessToken, tx, `${timestamp}.${random}`))) return reject();
  if (form.get("decision") === "deny") return callback(tx, { error: "access_denied" }, url);
  if (form.get("decision") !== "allow") return reject();
  try {
    const response = await fetch(`${INTERNAL_API_URL}/auth/mobile/code`, {
      method: "POST", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ challenge: tx.challenge, clientId: tx.clientId, redirectUri: CALLBACK }),
    });
    if (!response.ok) return callback(tx, { error: response.status === 401 ? "login_required" : "mint_failed" }, url);
    const { code } = await response.json() as { code?: string };
    if (!code || !/^[A-Za-z0-9_-]{43}$/.test(code)) return callback(tx, { error: "mint_failed" }, url);
    return callback(tx, { code }, url);
  } catch { return callback(tx, { error: "mint_failed" }, url); }
}
