// Real Electron smoke test, independent of a backend/account. Run after `build`:
//   pnpm --filter @use-brian/app-desktop exec electron scripts/test-browser-docking.mjs
// Linux without a display: xvfb-run -a -s '-screen 0 1920x1080x24' electron scripts/test-browser-docking.mjs
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, BaseWindow, ipcMain } from "electron";
import { EmbeddedBrowserHost } from "../dist/embedded-browser-host.js";

// Do not top-level-await app.whenReady(): Electron waits for ESM entry-point
// evaluation before emitting ready. Run the async fixture after module evaluation.
async function run() {
  const temporary = await mkdtemp(join(tmpdir(), "brian-browser-docking-"));
  app.setPath("userData", join(temporary, "profile"));
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  ipcMain.on("Use Brian:get-brian-nearby-state", (event) => {
    event.returnValue = false;
  });
  const mainHtml = `<!doctype html><html><head><style>
html,body{margin:0;height:100%;overflow:hidden;font:16px system-ui;background:#e8f0ff}
#root{width:100%;height:100vh} #fixed{position:fixed;right:12px;bottom:12px}
#dialog{position:fixed;inset:0;pointer-events:none;border:3px solid blue;box-sizing:border-box}
</style></head><body><div id="root"><h1>App pane fixture</h1><div id="dialog"></div>
<button id="fixed" onclick="this.dataset.clicked='yes'">App action</button></div></body></html>`;
  const siteHtml = `<!doctype html><html><body style="background:#fff8e0;font:16px system-ui">
<h1>Browser tab fixture</h1><input id="field" aria-label="Test field"><button>Submit</button>
<script>window.pageIdentity = crypto.randomUUID(); localStorage.setItem('fixture', 'preserved');</script>
</body></html>`;
  const fixtureFile = join(temporary, "app.html");
  await writeFile(fixtureFile, mainHtml);
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(req.url === "/app" ? mainHtml : siteHtml);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(predicate, label) {
    for (let n = 0; n < 100; n++) {
      if (await predicate()) return;
      await wait(50);
    }
    throw new Error(`Timed out: ${label}`);
  }
  const failures = [];
  let host;
  let main;
  let exitCode = 0;
  try {
    await app.whenReady();
    for (const mode of ["file", "http"]) {
      let stopped = 0,
        closed = 0,
        tabClosed = 0,
        detached = 0;
      main = new BrowserWindow({
        width: 1280,
        height: 860,
        show: true,
        autoHideMenuBar: true,
        webPreferences: {
          preload: fileURLToPath(
            new URL("../dist/preload.cjs", import.meta.url),
          ),
          partition: `fixture-app-${mode}`,
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });
      main.webContents.on("preload-error", (_event, _path, error) =>
        failures.push(error.message),
      );
      if (mode === "file") await main.loadFile(fixtureFile);
      else await main.loadURL(`${origin}/app`);
      host = new EmbeddedBrowserHost(
        `persist:embedded-browser-smoke-${mode}`,
        {
          stop: () => {
            stopped++;
          },
          closed: () => {
            closed++;
          },
          tabClosed: () => {
            tabClosed++;
          },
          detached: () => {
            detached++;
          },
        },
        { dockWindow: main },
      );
      host.show();
      const toolbarView = main.contentView.children[0];
      const toolbar = toolbarView.webContents;
      toolbar.on("preload-error", (_event, _path, error) =>
        failures.push(error.message),
      );
      await until(
        () =>
          toolbar
            .executeJavaScript("!!document.getElementById('detach')")
            .catch(() => false),
        "toolbar loaded",
      );
      const click = async (id) => {
        // Drive real input through the trusted toolbar, not a fabricated IPC event.
        const point = await toolbar.executeJavaScript(
          `(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
        );
        toolbar.sendInputEvent({
          type: "mouseDown",
          ...point,
          button: "left",
          clickCount: 1,
        });
        toolbar.sendInputEvent({
          type: "mouseUp",
          ...point,
          button: "left",
          clickCount: 1,
        });
        await wait(100);
      };
      async function checkAppWidth(reserved) {
        await until(async () => {
          const width = await main.webContents.executeJavaScript(
            "document.body.getBoundingClientRect().width",
          );
          return (
            Math.abs(
              width * main.webContents.getZoomFactor() -
                (main.getContentSize()[0] - reserved),
            ) < 2
          );
        }, `app width reserves ${reserved}`);
        const geometry = await main.webContents.executeJavaScript(`(()=>{
        const body=document.body.getBoundingClientRect(),fixed=document.getElementById('fixed').getBoundingClientRect(),dialog=document.getElementById('dialog').getBoundingClientRect();
        return {body:body.width,fixedRight:fixed.right,dialog:dialog.width};})()`);
        assert.ok(
          geometry.fixedRight <= geometry.body,
          "fixed action is inside the app pane",
        );
        assert.ok(
          Math.abs(geometry.dialog - geometry.body) < 2,
          "fixed dialog is contained in app pane",
        );
      }
      await checkAppWidth(480);
      assert.equal(
        BaseWindow.getAllWindows().length,
        1,
        "docked by default, no extra window",
      );
      const first = await host.createTab(`${origin}/site`, true);
      const tab = host.tabs().find((t) => t.id === first);
      const second = await host.createTab(`${origin}/other`, false);
      host.selectTab(first);
      const identity = await tab.contents.executeJavaScript("pageIdentity");
      const initialHandle = tab.handle;
      const originalSession = tab.contents.session;
      tab.contents.debugger.attach("1.3");
      await tab.contents.debugger.sendCommand("Runtime.evaluate", {
        expression: "document.getElementById('field').focus()",
      });
      await tab.contents.debugger.sendCommand("Input.insertText", {
        text: "Keep this text",
      });
      await originalSession.cookies.set({
        url: origin,
        name: "fixture",
        value: "preserved",
      });
      const verifyState = async () => {
        assert.equal(host.selectedId(), first);
        assert.equal(host.tabs()[0].contents, tab.contents);
        assert.equal(host.tabs()[0].handle, initialHandle);
        assert.equal(tab.contents.session, originalSession);
        assert.equal(
          await tab.contents.executeJavaScript("pageIdentity"),
          identity,
        );
        assert.equal(
          await tab.contents.executeJavaScript(
            "document.getElementById('field').value",
          ),
          "Keep this text",
        );
        assert.equal(
          await tab.contents.executeJavaScript(
            "localStorage.getItem('fixture')",
          ),
          "preserved",
        );
        assert.equal(
          (
            await originalSession.cookies.get({ url: origin, name: "fixture" })
          )[0].value,
          "preserved",
        );
        assert.ok(tab.contents.debugger.isAttached(), "CDP remains attached");
        const shot = await Promise.race([
          tab.contents.debugger.sendCommand("Page.captureScreenshot"),
          wait(5000).then(() => {
            throw new Error("Timed out capturing page after reparent/resize");
          }),
        ]);
        assert.ok(shot.data.length > 100, "CDP still captures the page");
        assert.deepEqual(
          [closed, tabClosed, detached],
          [0, 0, 0],
          "moving does not revoke/close tabs",
        );
      };
      for (let i = 0; i < 2; i++) {
        await click("detach");
        await until(() => toolbarView.getBounds().x === 0, "detached");
        const separate = BaseWindow.getAllWindows().find(
          (win) => win !== main && win.isVisible(),
        );
        assert.ok(separate, "separate browser window is visible");
        assert.ok(!main.contentView.children.includes(toolbarView));
        await checkAppWidth(0);
        await verifyState();
        if (i === 0) await click("dock");
        else separate.close();
        await until(
          () => main.contentView.children.includes(toolbarView),
          "docked back",
        );
        await checkAppWidth(480);
        await verifyState();
      }
      const pageView = main.contentView.children.find(
        (view) => view.webContents === tab.contents,
      );
      const beforeCollapseWidth = pageView.getBounds().width;
      await click("collapse");
      await checkAppWidth(56);
      assert.equal(
        pageView.getBounds().width,
        beforeCollapseWidth,
        "collapse preserves page viewport",
      );
      await click("rail-stop");
      assert.equal(stopped, 1, "Stop is reachable in collapsed rail");
      await click("expand");
      await checkAppWidth(480);
      // Keyboard resizing exercises the same clamped IPC path as pointer dragging.
      await toolbar.executeJavaScript(
        "document.getElementById('separator').focus()",
      );
      toolbar.sendInputEvent({ type: "keyDown", keyCode: "Left" });
      toolbar.sendInputEvent({ type: "keyUp", keyCode: "Left" });
      await checkAppWidth(496);
      for (const zoom of [0.8, 1.25, 1.5, 1]) {
        main.webContents.setZoomFactor(zoom);
        await checkAppWidth(496);
        assert.equal(
          toolbar.getZoomFactor(),
          1,
          "toolbar geometry does not inherit app zoom",
        );
      }
      main.reload();
      await once(main.webContents, "did-finish-load");
      await checkAppWidth(496);
      main.setContentSize(800, 720);
      await checkAppWidth(56);
      main.setContentSize(1280, 860);
      await checkAppWidth(496);
      console.log(`${mode}: resized/reloaded; verifying active page`);
      await verifyState();
      host.closeTab(second);
      // Main-window close disposes native views even while detached.
      await click("detach");
      console.log(`${mode}: closing main with detached browser`);
      main.close();
      await until(
        () => tab.contents.isDestroyed() && toolbar.isDestroyed(),
        "main close destroys owned contents",
      );
      assert.equal(closed, 1);
      host.destroy();
      host = null;
      main = null;
      console.log(
        `PASS ${mode}: native dock/detach, state/CDP, collapse/Stop, zoom, resize, reload and cleanup`,
      );
    }
    assert.deepEqual(failures, [], "no sandboxed preload errors");
    console.log(
      `Native browser docking smoke passed (Electron ${process.versions.electron})`,
    );
  } catch (error) {
    console.error(error);
    console.error("Preload errors:", failures);
    if (main && !main.isDestroyed())
      console.error(
        "App geometry:",
        main.getContentSize(),
        await main.webContents
          .executeJavaScript(
            "({body:document.body.getBoundingClientRect().width, inner:innerWidth, marker:document.documentElement.hasAttribute('data-native-browser-docked'),css:document.documentElement.style.cssText,style:document.getElementById('usebrian-native-browser-dock-style')?.textContent})",
          )
          .catch(() => null),
      );
    exitCode = 1;
  } finally {
    host?.destroy();
    if (main && !main.isDestroyed()) main.destroy();
    server.close();
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    app.exit(exitCode);
  }
}
void run().catch((error) => {
  console.error(error);
  app.exit(1);
});
