// Current-worktree capture; preserves the original before-evidence in screenshots/.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const tools = createRequire(resolve(process.env.AUDIT_TOOLS_DIR ?? repo, "package.json"));
const { chromium } = tools("playwright");
let launch = { headless: true };
if (process.env.AUDIT_SERVERLESS_CHROMIUM === "1") {
  const module = await import(tools.resolve("@sparticuz/chromium"));
  const bin = resolve(dirname(tools.resolve("@sparticuz/chromium")), "../bin/al2023.tar.br");
  await module.inflate(bin);
  const { tmpdir } = await import("node:os");
  module.setupLambdaEnvironment(resolve(tmpdir(), "al2023/lib"));
  launch = { ...launch, executablePath: await module.default.executablePath(), args: module.default.args };
}
const browser = await chromium.launch(launch);
const output = resolve(here, "../screenshots/after");
await mkdir(output, { recursive: true });
const app = process.env.AUDIT_APP_URL ?? "http://127.0.0.1:3203";
const auth = process.env.AUDIT_AUTH_URL ?? "http://127.0.0.1:3205";
const preview = process.env.AUDIT_PREVIEW_URL ?? "http://127.0.0.1:3210";
const pages = process.env.AUDIT_PAGE_URL ?? "http://127.0.0.1:3211";
const shots = [
  ...["light", "dark"].map(mode => ({ id: "REF", name: `reference-accounts-${mode}-desktop`, url: `${app}/accounts`, kind: "public-page", width: 1440, height: 1000, mode })),
  ...[{ width: 1440, mode: "light" }, { width: 1440, mode: "dark" }, { width: 360, mode: "dark" }].map(({width, mode}) => ({
    id: "F01", name: `f01-auth-login-${mode}-${width}`, url: `${auth}/login`, kind: "public-page", width, height: width === 360 ? 800 : 1000, mode,
  })),
  ...["renderers", "workflow", "association", "shopify"].flatMap((surface, i) => ["light", "dark"].map(mode => ({
    id: `F0${i+2}`, name: `f0${i+2}-${surface}-${mode}-desktop`, url: `${preview}/?surface=${surface}&mode=${mode}`,
    kind: "isolated-production-components", surface, width: 1440, height: 1000, mode,
  }))),
  { id: "F06", name: "f06-emoji-dark-desktop", url: `${preview}/?surface=emoji&mode=dark`, kind: "isolated-production-components", surface: "emoji", width: 1440, height: 1000, mode: "dark" },
  ...[360, 639, 640, 700, 767, 768, 1024].map(width => ({
    id: "F07", name: `f07-controls-light-${width}`, url: `${preview}/?surface=controls&mode=light`,
    kind: "isolated-production-components", surface: "controls", width, height: 800, mode: "light", coarse: width === 1024,
  })),
  ...["workflow", "shopify"].flatMap(surface => [
    { width: 1440, mode: "light" }, { width: 1440, mode: "dark" }, { width: 700, mode: "light" }, { width: 360, mode: "light" },
    ...(surface === "workflow" ? [{ width: 1440, mode: "light", state: "settings" }, { width: 360, mode: "light", state: "trigger" }, { width: 360, height: 500, mode: "light", state: "inspector" }] : []),
  ].map(({ width, height = 900, mode, state = "default" }) => ({
    id: "PAGE", name: `page-${surface}-${mode}-${width}-${state}`, url: `${pages}/page.html?page=${surface}&section=analyse&mode=${mode}`,
    kind: "production-route-body-synthetic-data", surface, width, height, mode, state,
  }))),
];
// Pin the audited source set, even after the fixes have been committed. A git
// diff alone becomes empty on clean checkouts and cannot identify captured code.
const sourcePaths = [
  "apps/app-web/src/components/association/__tests__/event-workspace.test.tsx",
  "apps/app-web/src/components/association/__tests__/ui.test.tsx",
  "apps/app-web/src/components/association/events/event-page-editor.tsx",
  "apps/app-web/src/components/association/ui.tsx",
  "apps/app-web/src/components/shopify/analyse-tab.tsx",
  "apps/app-web/src/components/shopify/campaign-tab.tsx",
  "apps/app-web/src/components/ui/__tests__/button.test.ts",
  "apps/app-web/src/components/ui/button.tsx",
  "apps/app-web/src/components/ui/checkbox.tsx",
  "apps/app-web/src/components/ui/emoji-picker.tsx",
  "apps/app-web/src/components/ui/select.tsx",
  "apps/app-web/src/components/ui/switch.tsx",
  "apps/app-web/src/components/workflow/trigger-editor.tsx",
  "apps/app-web/src/lib/theme.tsx",
  "apps/auth-web/src/app/globals.css",
  "packages/views-renderer/src/properties/checkbox.tsx",
  "packages/views-renderer/src/properties/files.tsx",
  "packages/views-renderer/src/widgets/Button.tsx",
];
const dirty = execFileSync("git", ["diff", "--name-only", "HEAD", "--", ...sourcePaths], { cwd: repo, encoding: "utf8" }).trim() !== "";
const manifest = {
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  worktree: dirty
    ? "Uncommitted changes to captured source files; sourceRevision identifies the parent commit. See sourceFiles hashes."
    : "Clean captured source files at sourceRevision. See sourceFiles hashes.",
  sourceFiles: await Promise.all(sourcePaths.map(async file => ({ file, sha256: createHash("sha256").update(await readFile(resolve(repo, file))).digest("hex") }))),
  capturedAt: new Date().toISOString(), browser: await browser.version(), deviceScaleFactor: 1,
  locale: "en-US", timezone: "UTC", reducedMotion: "reduce", palette: "notion",
  caveats: [
    "Only accounts and auth login are real public pages. No authentication, external actions or browser /api requests.",
    "PAGE captures mount production route bodies with synthetic read-only data: header/tabs/content/overlays, NOT a session, workspace sidebar or real cross-route navigation.",
    "Other feature captures mount isolated production components, not authenticated pages. No product styling is patched; only the labeled documentation frame and Next dev indicator are styled.",
    "No mobile Safari, native desktop, custom palette visual or full authenticated workspace validation. Coarse pointer uses Chromium hasTouch emulation.",
    "Linux fallback fonts differ from native systems; unavailable emoji/CJK glyphs are capture artifacts, not product findings.",
    "fixtureRequests includes automatic picker-preferences PATCH attempts; the synthetic transport rejects every non-GET before forwarding or network.",
  ], screenshots: [],
};
try {
  for (const shot of shots) {
    const context = await browser.newContext({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 1,
      locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce", hasTouch: shot.coarse ?? false, colorScheme: shot.mode });
    await context.addInitScript(mode => { localStorage.setItem("doc:theme", mode); localStorage.setItem("doc:palette", "notion"); }, shot.mode);
    const blockedRequests = [];
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname.startsWith("/api/")) {
        blockedRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const response = await page.goto(shot.url, { waitUntil: "networkidle", timeout: 120000 });
    assert.equal(response.status(), 200, `${shot.name}: HTTP response`);
    if (shot.kind === "production-route-body-synthetic-data") {
      await page.locator(".audit-page-label").waitFor();
      if (shot.surface === "workflow") {
        await page.locator(shot.width < 768 ? '[data-workflow-mobile-step="trigger"]' : '[data-node-key="__trigger"]').waitFor();
        await page.getByText("Checking delivery permissions", { exact: true }).waitFor({ state: "hidden" });
        if (shot.state === "settings") await page.getByRole("tab", { name: "Settings", exact: true }).click();
        if (shot.state === "inspector" || shot.state === "trigger") {
          await page.locator(`[data-workflow-mobile-step="${shot.state === "trigger" ? "trigger" : "read"}"]`).click();
          await page.getByRole("dialog").waitFor();
        }
      } else await page.getByRole("button", { name: "Run it", exact: true }).waitFor();
    } else await page.locator("h1").waitFor();
    await page.evaluate(() => document.fonts.ready);
    if (shot.kind === "public-page") {
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      if (shot.id === "F01") await page.getByRole("textbox", { name: "Email address" }).focus();
    }
    if (shot.surface === "emoji") {
      await page.getByRole("button", { name: "Choose page icon" }).click();
      await page.locator("em-emoji-picker").waitFor();
      await page.waitForTimeout(500);
      const search = page.locator('em-emoji-picker input[type="search"]');
      await search.fill("smile");
      await search.focus();
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
      await page.waitForFunction(() => getComputedStyle(document.querySelector('em-emoji-picker').shadowRoot.querySelector('#root')).backgroundColor === 'rgb(255, 255, 255)');
      assert.equal(await search.inputValue(), "smile", "Live theme update preserves search");
      assert.equal(await search.evaluate(el => el.getRootNode().activeElement === el), true, "Live theme update preserves focus");
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await page.waitForFunction(() => getComputedStyle(document.querySelector('em-emoji-picker').shadowRoot.querySelector('#root')).backgroundColor !== 'rgb(255, 255, 255)');
      await search.fill("");
      await page.getByRole("button", { name: "Remove", exact: true }).focus();
    }
    const touch = shot.width < 768 || shot.coarse;
    if (shot.surface === "controls" && touch) {
      for (const role of ["checkbox", "switch"]) {
        const control = page.getByRole(role, { name: `Example ${role}` });
        const p = await control.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2 - 20, y: r.y + r.height / 2 - 20 }; });
        const before = await control.getAttribute("aria-checked");
        await page.mouse.click(p.x, p.y);
        assert.notEqual(await control.getAttribute("aria-checked"), before, `${role}: expanded corner must hit`);
        await page.mouse.click(p.x, p.y);
      }
    }
    const scrollOwners = shot.kind === "production-route-body-synthetic-data" ? await page.evaluate(() => {
      return [...document.querySelectorAll('*')].filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY);
      }).map(el => {
        const before = el.scrollTop;
        el.scrollTop = el.scrollHeight;
        const reachedBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
        const result = { tag: el.tagName, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, reachedBottom };
        el.scrollTop = before;
        return result;
      });
    }) : [];
    assert.ok(scrollOwners.every(owner => owner.reachedBottom), `${shot.name}: all scroll owners reach bottom`);
    const measurements = await page.evaluate(() => {
      const pick = el => {
        const c = getComputedStyle(el), r = el.getBoundingClientRect();
        return { tag: el.tagName, label: el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 80), width: r.width, height: r.height,
          background: c.backgroundColor, color: c.color, border: c.borderColor, fontSize: c.fontSize,
          ...(el.matches('[role="checkbox"], [role="switch"]') ? { pseudoTarget: { width: getComputedStyle(el, "::after").width, height: getComputedStyle(el, "::after").height },
            reservedArea: { width: el.parentElement.getBoundingClientRect().width, height: el.parentElement.getBoundingClientRect().height } } : {}) };
      };
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && el.getAttribute('aria-hidden') !== 'true'; };
      const root = getComputedStyle(document.documentElement);
      const picker = document.querySelector('em-emoji-picker')?.shadowRoot?.querySelector('#root');
      return {
        root: { background: root.getPropertyValue("--background").trim(), action: root.getPropertyValue("--action").trim(), ring: root.getPropertyValue("--ring").trim() },
        elements: [...document.querySelectorAll('[data-audit], [data-audit=renderer-primitives] button, [role=checkbox], [role=switch], [role=radio][aria-checked=true], button[aria-pressed=true], .input:focus')].filter(visible).map(pick),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        heading: document.querySelector("h1")?.textContent ?? document.title,
        dialogs: [...document.querySelectorAll('[role="dialog"]')].filter(visible).map(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom, horizontalOverflow: el.scrollWidth > el.clientWidth }; }),
        compactControls: innerWidth < 768 ? [...document.querySelectorAll('button, [role="tab"], input:not([type="hidden"]), textarea')].filter(visible).map(pick).filter(el => el.width < 44 || el.height < 44).slice(0, 60) : [],
        fixtureRequests: window.auditRequests ?? [],
        pickerBackground: picker ? getComputedStyle(picker).backgroundColor : null,
        coarsePointer: matchMedia('(pointer: coarse)').matches,
      };
    });
    measurements.scrollOwners = scrollOwners;
    assert.deepEqual(errors, [], `${shot.name}: browser errors`);
    assert.equal(measurements.horizontalOverflow, false, `${shot.name}: page overflow`);
    if (shot.surface === "renderers") {
      const buttons = measurements.elements.filter(e => e.tag === "BUTTON");
      assert.equal(buttons[0].height, 32);
      assert.equal(buttons[0].background, shot.mode === "dark" ? "rgb(212, 212, 212)" : "rgb(55, 53, 47)");
      assert.equal(buttons[1].background, buttons[0].background, "Renderer and app action agree");
    }
    if (shot.surface === "controls") {
      assert.equal(measurements.elements.find(e => e.label === "Default action").height, touch ? 44 : 32);
      assert.equal(measurements.elements.find(e => e.label === "Add item").height, touch ? 44 : 32);
      assert.equal(measurements.coarsePointer, Boolean(shot.coarse));
    }
    if (shot.surface === "emoji") assert.notEqual(measurements.pickerBackground, "rgb(255, 255, 255)");
    const png = await page.screenshot({ path: resolve(output, `${shot.name}.png`), fullPage: true, animations: "disabled" });
    manifest.screenshots.push({ ...shot, file: `${shot.name}.png`, pngWidth: png.readUInt32BE(16), pngHeight: png.readUInt32BE(20),
      sha256: createHash("sha256").update(png).digest("hex"), measurements, pageErrors: errors, blockedRequests });
    console.log(`Captured ${shot.name}`);
    // Single-process portable Chromium: defer context cleanup until browser.close().
  }
} finally { await browser.close(); }
await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const gallery = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Design system: after fixes and route-body checks</title>
<style>body{font:16px/1.5 system-ui;margin:32px;background:#f7f7f5;color:#37352f}main{max-width:1200px;margin:auto}section{padding:20px;margin:24px 0;background:white;border:1px solid #ddd;border-radius:12px}img{display:block;max-width:100%;height:auto;margin-top:12px;border:1px solid #ddd}h2{font-size:18px}code{overflow-wrap:anywhere}</style>
<main><h1>After F01–F07 fixes</h1><p>${manifest.capturedAt} · Chromium ${manifest.browser} · ${manifest.screenshots.length} captures · revision <code>${manifest.sourceRevision}</code></p>
<p>${manifest.worktree}</p>
<p>Public pages, isolated components and synthetic route bodies are classified per image. Route bodies include real headers/tabs/overlays but not a session or persistent sidebar. No external actions or API writes.</p>
<p><a href="../index.html">Before gallery</a> · <a href="../../implementation.md">Fixes and page-level findings</a> · <a href="../README.md">Capture method</a> · <a href="manifest.json">Measurements</a></p>
${manifest.screenshots.map(s => `<section><h2>${s.name}</h2><p>${s.kind} · ${s.width} × ${s.height} · ${s.mode}${s.coarse ? " · emulated coarse pointer" : ""}</p><a href="${s.file}"><img src="${s.file}" alt="${s.name}" loading="lazy" width="${s.pngWidth}" height="${s.pngHeight}"></a></section>`).join("\n")}</main></html>`;
await writeFile(resolve(output, "index.html"), gallery + "\n");
console.log(`Wrote ${manifest.screenshots.length} after captures`);
