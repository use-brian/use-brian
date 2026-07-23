# apps/browser-extension — "My Browser" local backend

The Chrome/Edge extension that lets a Use Brian assistant drive the user's own
browser (the local backend, surfaced in-product as **My Browser**). Spec:
[`docs/architecture/engine/computer-use.md`](../../docs/architecture/engine/computer-use.md) §1/§5 + plan
[`docs/plans/my-browser.md`](../../docs/plans/my-browser.md). Pairs to the account via the
browser-relay (`apps/browser-relay`); the app-web connect surface is
`[COMP:app-web/connect-browser]`.

## Modules

- `background.ts` — service worker: relay connection, consent prompt, command dispatch.
- `relay-client.ts` — the one WebSocket to the relay (`hello` / command / result / event).
- `executor.ts` — the discrete browser ops against the one allowed tab, via `chrome.debugger` (CDP) only.
- `task-gate.ts` — per-task consent + single-tab scope + persistent Stop (`[COMP:ext/agent]`).
- `tab-eligibility.ts` — which tabs CDP can attach to; an unattachable page raises `no_eligible_tab`, never `consent_denied`.
- `pairing.ts` — the credential transition behind every Connect, plus the `externally_connectable` sender check (`[COMP:ext/pairing]`).
- `snapshot.ts` — CDP accessibility tree into the shared snapshot shape.
- `popup.ts` / `popup-status.ts` / `allow.ts` — the pairing popup, its status wording, and the per-task allow prompt.

## Governance guardrail (my-browser.md §4 D4 / §6) — DO NOT WIDEN

The narrow surface **is** the feature. The extension:

- drives ONLY via `chrome.debugger` (CDP) against one user-approved tab — no content scripts, no `cookies` / `scripting` / `webRequest`;
- requests NO `host_permissions` (`permissions` stays `["debugger","tabs","storage"]` — `chrome.debugger` needs no host grant);
- gates every task on explicit per-tab consent (`task-gate.ts`), scopes to that tab, and honors a persistent Stop + close-to-kill.

A broad `<all_urls>` / cookies / content-script grant is the **Manus Browser Operator anti-pattern** (Mindgard "Rubra" credential-exfil + Aurascape "SilentBridge" CVSS 9.8 zero-click takeover). Never add it. `src/__tests__/manifest.test.ts` locks the narrow permission set as a regression guard.

**`externally_connectable` is the one exception, and it is not a widening.** It admits `sendMessage` from our own app origins so the web app can hand over a pairing code (one-click pairing); it is inbound-only, carries pairing config alone, and grants the extension no reach into any page. Two rules keep it that way: the allowlist is pinned by `manifest.test.ts` (no wildcard, no bare TLD, https everywhere but loopback), and `background.ts` re-checks `sender.origin` against **the manifest's own list** via `chrome.runtime.getManifest()` — never a second hardcoded copy, because the copy that drifts would be the security boundary.
