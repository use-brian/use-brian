# README showcase

The README animation follows three chapters, in this order:

1. **Feature showcase:** store documents in Page; browse with the browser
   extension; record meetings; manage Tasks and CRM; start workflows from
   schedules and webhooks.
2. **Built for business and teams:** bring information into one brain; retrieve,
   synthesize and update it in Chat; work together in shared chats; scope context
   by Department, Project and clearance; govern agent actions; choose hosted or
   self-hosted deployment.
3. **Connectivity:** connect messaging channels; use other agents as tools and
   expose Brian to external agents through MCP; build an app with assistant APIs.

Capture the current product components with a fictional example workspace.
Label the result as an example. Do not publish real accounts, customer records,
credentials, browser history or provider responses. Example transport data is
illustrative, not evidence of a completed live integration or model run.

Keep the app's current navigation and controls visible. Put explanatory captions
outside the product frame. Use neutral interaction colors and no em dashes.
The GIF must remain readable at the README's 960px display width. Supply a
larger MP4 for playback with pause and seek controls, and keep scene timing and
capture instructions here so future UI changes can be recaptured.

## Current export

Captured on 2026-11-04. The tour is 69 seconds across 16 scenes:

| Chapter | Scenes | Time |
| --- | --- | --- |
| Feature showcase | Page, browser extension, recording, Tasks, CRM, workflow triggers | 0:00-0:25 |
| Built for business and teams | Shared brain, team chat, organization, clearance, permissions, deployment | 0:25-0:51 |
| Connectivity | Channels, specialist agent, brain MCP, assistant API | 0:51-1:09 |

`../demo.gif` is the looping 960 × 656 README preview. `../demo.mp4` is the
1200 × 820 H.264 version. `poster.png` is the opening scene.

The app frame is captured from the current `apps/app-web` components through
their desktop SPA build, with the current browser extension side panel inside
a fictional supplier page. `fixture.js` and `extension-fixture.js` replace
transport responses and supply example messages; they do not replace product
components. Page content uses the real Yjs document model and a temporary local
Hocuspocus server. This is an illustrative UI tour, not an end-to-end integration
test. Explanatory titles, captions and progress appear outside the app frame.

## Recapture

Prerequisites: the workspace dependencies installed, Node, pnpm, ffmpeg, and
Playwright with Chromium. No backend, provider credentials or real workspace
are needed. Run these commands from the `use-brian` repository root:

```bash
export DEMO_WORK_DIR="$(mktemp -d)"
npm install --prefix "$DEMO_WORK_DIR/tools" --no-save playwright
export PLAYWRIGHT_MODULE="$DEMO_WORK_DIR/tools/node_modules/playwright/index.mjs"
node "$DEMO_WORK_DIR/tools/node_modules/playwright/cli.js" install chromium
pnpm --filter @use-brian/doc-model build
pnpm --filter @use-brian/browser-extension build
pnpm --dir apps/app-web exec vite build --config vite.desktop.config.ts --outDir "$DEMO_WORK_DIR/renderer"
node assets/demo/capture.mjs
node assets/demo/render.mjs
```

To use an installed Chrome instead, set `CHROME_EXECUTABLE` to its executable
path. `DEMO_RENDERER_DIR` can select an already built SPA. The capture uses
loopback ports 4399 and 44399, which must be free, and blocks external browser
requests. It fails on browser JavaScript errors or broken images. Temporary
services and the browser close when capture ends.

Scene order, captions and durations live in `capture.mjs`. `ONLY_SCENES=page,crm`
recaptures selected scenes in an existing work directory. A full capture is
required before the first render. Rendered stills and `contact-sheet.png` stay
under `$DEMO_WORK_DIR/frames/` for visual review. Check all scenes, especially
trigger types, permission states and scope labels, before replacing the public
media. Check the final MP4 and GIF duration and dimensions with `ffprobe`.
