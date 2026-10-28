// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "./login-form";
import { I18nProvider } from "@/lib/i18n/client";
import { en, ja, zh, zhCN, type Dictionary } from "@/lib/i18n/dictionaries";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const navigation = vi.hoisted(() => ({ search: new URLSearchParams(), refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.search,
  useRouter: () => ({ refresh: navigation.refresh, push: navigation.push, replace: navigation.replace }),
}));

let host: HTMLDivElement;
let root: Root;
let request: ReturnType<typeof vi.fn>;
let dictionary: Dictionary;
const recipient = "member@signin.example";
const returnPath = "/invite?token=fictional-invitation";
const input = () => host.querySelector<HTMLInputElement>("input")!;
const button = (label: string) => {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === label);
  expect(found, `Missing button: ${label}`).toBeDefined();
  return found!;
};
const response = (status = 200, body: object = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function deferred() {
  let resolve!: (value: ReturnType<typeof response>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ReturnType<typeof response>>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function render(props = { emailEnabled: true, oidcEnabled: false, oidcProviderName: "Example SSO" }) {
  await act(async () => root.render(<I18nProvider dictionary={dictionary}><LoginForm {...props} /></I18nProvider>));
}
async function fill(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function enterCode() {
  await render(); await fill(recipient); await submit();
  expect(input().autocomplete).toBe("one-time-code");
}
const payload = (index: number) => JSON.parse(request.mock.calls[index][1].body as string);
function associatedError(text: string, invalid: boolean) {
  const error = host.querySelector<HTMLElement>('[role="alert"]');
  expect(error?.textContent).toBe(text);
  expect(error?.id).toBeTruthy();
  expect(input().getAttribute("aria-describedby")?.split(/\s+/)).toContain(error!.id);
  expect(input().getAttribute("aria-invalid") === "true").toBe(invalid);
}

beforeEach(() => {
  navigation.search = new URLSearchParams({ next: returnPath });
  navigation.refresh.mockReset(); navigation.push.mockReset(); navigation.replace.mockReset();
  dictionary = en;
  document.documentElement.lang = "en";
  document.cookie = "locale=; Path=/; Max-Age=0";
  request = vi.fn().mockResolvedValue(response()); vi.stubGlobal("fetch", request);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("[COMP:app/outpost-auth] email-code recovery and locale continuity", () => {
  it("keeps required labelled email and six-digit code validation", async () => {
    await render();
    expect(input().labels?.[0].textContent).toContain(en.login.emailLabel);
    expect(input().checkValidity()).toBe(false);
    await fill("malformed"); expect(input().checkValidity()).toBe(false);
    await fill(recipient); expect(input().checkValidity()).toBe(true); await submit();
    expect(input().labels?.[0].textContent).toContain(en.login.codeLabel);
    expect(button(en.login.verify).disabled).toBe(true);
    await fill("12a34"); expect(input().value).toBe("1234"); expect(button(en.login.verify).disabled).toBe(true);
    await fill("123456"); expect(button(en.login.verify).disabled).toBe(false);
  });

  it("shows the actual requested recipient and focuses code entry without changing the canonical payload", async () => {
    await enterCode();
    expect(host.textContent).toContain(recipient); expect(document.activeElement).toBe(input());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("/api/auth/email/request-link");
    expect(payload(0)).toEqual({ email: recipient, nextPath: returnPath, locale: "en" });
    expect(host.querySelector('[role="status"]')?.textContent ?? "").not.toMatch(/delivered|successfully sent/i);
  });

  it("changes email without sending, retaining the address and clearing stale code/error", async () => {
    await enterCode(); await fill("123456"); request.mockResolvedValueOnce(response(401)); await submit();
    await click(button("Change email"));
    expect(input().type).toBe("email"); expect(input().value).toBe(recipient); expect(document.activeElement).toBe(input());
    expect(host.querySelector('[role="alert"]')).toBeNull(); expect(host.querySelector('[role="status"]')?.textContent ?? "").toBe("");
    expect(request).toHaveBeenCalledTimes(2);
    await submit(); expect(input().value).toBe(""); expect(button(en.login.verify).disabled).toBe(true);
    expect(navigation.push).not.toHaveBeenCalled(); expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("resends manually to the same address with neutral feedback and clears stale code/error", async () => {
    await enterCode(); await fill("123456"); request.mockResolvedValueOnce(response(401)); await submit();
    const pending = deferred(); request.mockReturnValueOnce(pending.promise);
    await click(button("Resend sign-in email"));
    expect(input().value).toBe(""); expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(payload(2)).toEqual({ email: recipient, nextPath: returnPath, locale: "en" });
    expect(host.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    expect(button("Change email").disabled).toBe(true); expect(button(en.login.verify).disabled).toBe(true);
    expect(button("JA").disabled).toBe(true); expect(host.textContent).not.toContain(en.login.verifying);
    await act(async () => pending.resolve(response()));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Request received. If this address is eligible, check its inbox for a sign-in link or code.");
    expect(document.activeElement).toBe(input()); expect(button("Change email").disabled).toBe(false);
  });

  it("deduplicates same-turn submissions and prevents recipient edits or locale changes while sending", async () => {
    await render(); await fill(recipient);
    const pending = deferred(); request.mockReturnValueOnce(pending.promise);
    await act(async () => {
      const form = host.querySelector("form")!;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(request).toHaveBeenCalledTimes(1); expect(input().disabled).toBe(true); expect(button("JA").disabled).toBe(true);
    await act(async () => pending.resolve(response()));
    expect(host.textContent).toContain(recipient);
  });

  it("deduplicates same-turn resend activation and recovers from a rejected resend", async () => {
    await enterCode(); const pending = deferred(); request.mockReturnValueOnce(pending.promise);
    await act(async () => { const resend = button("Resend sign-in email"); resend.click(); resend.click(); });
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => pending.reject(new Error("synthetic network failure")));
    associatedError(en.login.unavailable, false); expect(document.activeElement).toBe(input());
    expect(button("Resend sign-in email").disabled).toBe(false); expect(button("Change email").disabled).toBe(false);
    expect(host.querySelector('[role="status"]')?.textContent ?? "").toBe("");
  });

  it.each([
    [401, {}, "invalidCode", true], [429, {}, "locked", false],
    [403, { error: "enrollment_required" }, "enrollment", false], [500, {}, "unavailable", false],
  ] as const)("preserves verification status %s, associates its error and only marks invalid code invalid", async (status, body, key, invalid) => {
    await enterCode(); await fill("123456"); request.mockResolvedValueOnce(response(status, body)); await submit();
    associatedError(en.login[key], invalid); expect(document.activeElement).toBe(input());
    expect(request.mock.calls[1][0]).toBe("/api/auth/email/verify-code");
    expect(payload(1)).toMatchObject({ email: recipient, code: "123456", timezone: expect.any(String) });
    dictionary = ja; await render(); associatedError(ja.login[key], invalid);
  });

  it("announces a rejected initial request without mislabelling the address invalid", async () => {
    await render(); await fill(recipient); request.mockRejectedValueOnce(new Error("synthetic network failure")); await submit();
    expect(input().type).toBe("email"); associatedError(en.login.unavailable, false); expect(document.activeElement).toBe(input());
    expect(button(en.login.send).disabled).toBe(false);
  });

  it.each([
    ["link_expired", "linkExpired"], ["enrollment_required", "enrollment"], ["oidc_failed", "oidcFailed"], ["unknown", "unavailable"],
  ] as const)("translates existing query error %s when the provider receives the refreshed dictionary", async (query, key) => {
    navigation.search.set("error", query); await render(); associatedError(en.login[key], false);
    dictionary = ja; await render(); associatedError(ja.login[key], false);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "EN", en], ["ja", "JA", ja], ["zh", "繁", zh], ["zh-CN", "简", zhCN],
  ] as const)("refreshes exact locale %s and retains mounted code-step state through the dictionary update", async (locale, label, nextDictionary) => {
    await enterCode(); await fill("123456"); request.mockResolvedValueOnce(response(401)); await submit();
    navigation.refresh.mockImplementationOnce(() => expect(document.cookie).toContain(`locale=${locale}`));
    await click(button(label)); expect(navigation.refresh).toHaveBeenCalledTimes(1);
    dictionary = nextDictionary; document.documentElement.lang = locale; await render();
    expect(input().autocomplete).toBe("one-time-code"); expect(input().value).toBe("123456"); expect(host.textContent).toContain(recipient);
    associatedError(nextDictionary.login.invalidCode, true); expect(request).toHaveBeenCalledTimes(2);
    expect(navigation.push).not.toHaveBeenCalled(); expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("translates neutral resend status without losing code entry or issuing another email", async () => {
    await enterCode(); await click(button("Resend sign-in email")); dictionary = ja; await render();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(ja.login.requestAccepted);
    expect(input().autocomplete).toBe("one-time-code"); expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("preserves the OIDC entry and return target when emailEnabled=%s", async (emailEnabled) => {
    await render({ emailEnabled, oidcEnabled: true, oidcProviderName: "Example SSO" });
    const link = host.querySelector<HTMLAnchorElement>("a")!;
    expect(link.textContent).toContain("Example SSO"); expect(link.getAttribute("href")).toBe(`/api/auth/oidc/start?next=${encodeURIComponent(returnPath)}`);
    expect(Boolean(host.querySelector('input[type="email"]'))).toBe(emailEnabled);
    expect(host.querySelectorAll("button")).toHaveLength(emailEnabled ? 5 : 4);
  });
});
