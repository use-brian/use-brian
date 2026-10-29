# Page Drawings

## Assistant Live Drawing Tools

`getDrawing` reads the authoritative live drawing and returns its namespace and
compact shape metadata (IDs, geometry, text, groups and bindings). `editDrawing`
accepts bounded move, resize, connect and insertLibraryItem actions, targeting a
page, block and the namespace from that read. It requires the live-doc gateway;
there is no whole-scene snapshot fallback. A replaced/deleted drawing, missing or
locked shape, invalid action or retention overflow rejects the action batch before
any geometry is written. Operations resolve against the current server scene,
then publish one validated element delta through DrawingCollaboration. The embed
base and epoch stay unchanged, so mounted editors receive changes immediately.
Independent human shape edits survive; same-element races retain Yjs resolution.
An active human gesture remains protected until release by the existing editor.
Assistant changes do not enter a human editor's local undo history.

Move applies a relative offset to the selected shapes and their bound labels.
Resize changes one shape's dimensions, scaling line/freehand points and text
metrics where applicable. Bound labels remain centered. Straight bound connectors
are recomputed after geometry edits; unsupported elbow connectors and frame
transforms are refused instead of leaving invalid geometry. Connect creates a
straight bound arrow between two rectangle, diamond or ellipse shapes, maintaining
both endpoint binding lists. Insert clones a validated library item at the requested
scene position, assigning fresh shape/group IDs and remapping internal references;
external references are removed. All actions preserve existing raster assets.

`listDrawingLibrary` lists bounded, searchable item metadata from the shared Brian
default library or an attached `.excalidrawlib` cached file. Insertion takes the
returned item ID and optional file ID; the model never supplies scene JSON.
Chat uploads recognize `.excalidrawlib` even with a generic MIME type and validate
the bounded library before caching its text. File reads use the caller's
workspace/clearance context. Browser-local personal libraries remain local: export
and attach one to make its items available to the assistant. No browser preferences are uploaded automatically. Legacy library
strokes are normalized and library sizes/assets obey the existing import limits.
The assistant tools are available in the selected Page's governed document editor
and the read tools in the conversational loop. Server page mutation authorization
and Brief Direction protection apply through the existing internal apply endpoint.

Run `node apps/app-web/scripts/drawing-assistant-browser.mjs` for the isolated
two-editor regression of server-originated actions over real WebSockets.

## Live Collaboration

### Page Transport And Preview

The page hook and closed-local-page uploader explicitly attach each document
provider to their externally owned Hocuspocus socket before connecting it.
Opening a WebSocket alone does not authenticate, subscribe, sync, or forward
status/awareness for that document in Hocuspocus 4. A saved local page can otherwise
look editable while its document provider never participates in collaboration.

The embedded drawing remains a live scene-derived canvas when its SDK editor is
closed, including for read-only page viewers. Rendering must make progress during
continuous edits, not wait for a pause in remote traffic. A previous canvas stays
mounted until its replacement is ready; empty or invalid scenes clear it. This
canvas is separate from the digest-bound PNG persisted for exports and AI reads.

Clicking the embedded preview (or its keyboard-accessible expand control) opens
the shared visual lightbox with pan and zoom, without entering the drawing editor.
A Download PNG control exports the complete rendered image, not the clipped page
thumbnail. Both controls are available to read-only viewers. Empty, failed and
quarantined previews have no image actions; editing remains a separate action.
The lightbox and download follow the current scene-derived preview and theme,
without mutating the page or relying on a persisted preview.

`node apps/app-web/scripts/drawing-page-browser.mjs` exercises two independent
browser contexts through `useCollabProvider`, `CollabPageEditor`, the real Tiptap
React node view and SDK. It uses an isolated Hocuspocus server with the production
OSS `/auth/local-session` token endpoint, JWT verifier and drawing protocol gate,
synthetic identity/page access, and no application database. It covers held-drag
updates, late joins, same-account presence, continuous previews, read-only embedded
viewing, reload and reconnect. The Next routing APIs use the existing desktop
Vite shims; this is not a deployed Next/OSS-stack or RLS test. The endpoint's
edition gate and user-store boundary are injected; JWT creation and verification
are real. The runner rejects a legacy protocol against the seeded drawing too.
Late SDK initialization can reset its collaborator map after the first awareness
paint. SDK scene notifications repair that reset from current awareness, without
waiting for the remote person to move and without persisting presence.

The standard OSS launcher already starts doc-sync on port 8080 and supplies the
same JWT secret to the API and doc-sync. No new flag or migration is needed.
For a remote self-host, configure a browser-reachable `PUBLIC_DOC_SYNC_URL`
(or `DOC_SYNC_DOMAIN`, or build-time `NEXT_PUBLIC_DOC_SYNC_URL`); HTTPS pages
need `wss://`. The unconfigured development fallback is `ws://localhost:8080`,
which points to the browser's machine, not a remote host. `DOC_SYNC_URL` is the
API's internal endpoint, not the browser runtime setting. Keep the app and
doc-sync drawing-protocol versions aligned and refresh old browser bundles.

### Review Safety Contracts

Immutable file registers are not undoable. An insertion's undo removes only its
local shapes, never files that another peer may already reference. Undo's deletion
filter excludes immutable file insertions, keeping assets and elements atomic in
one transport update without making those assets undoable.

SDK baseline capture accepts structurally valid over-limit scenes, including on
reopen. Limits apply to the resulting canonical delta projection, not the SDK's
expanded default fields. The first repair gesture must publish, not become a new
unpublished baseline.

Live-register retention admission counts ALL nonempty drawing namespaces in the page, including
retired epochs, tombstones, files and previews, plus immutable drawing base JSON:
16 MiB of serialized retained data,
50,000 registers and 128 namespaces. Growing authored writes above these budgets
are refused visibly; removals and non-growing edits remain possible. Offline
concurrent unions can exceed admission budgets and are preserved, not truncated.
These are live-register admission budgets, not a claim that Yjs binary history is
size-bounded. Undo, concurrent unions, API whole-block replacements, page imports
and arbitrary authenticated Yjs updates are not a hard server-enforced storage cap.
There is deliberately no automatic age-based GC: offline peers and local undo may
still reference old assets/epochs. Safe compaction requires a coordinated fresh
document generation with all old writers retired; no such page-generation reset
protocol exists yet, so automatic compaction is not shipped. Reaching retention
capacity requires moving a canonical copy into a fresh page; deleting visible
shapes alone does not reclaim immutable assets. Tombstone/undo safety takes priority
over pretending that visible scene size bounds storage.

New page providers advertise a drawing protocol capability inside the existing
JWT authentication message. Legacy clients can still write pages without drawings;
before accepting their sync updates the server checks both current and proposed
state and refuses writes involving drawing pages, including first insertion.
This also gates legacy sessions already connected when a drawing arrives. Refusal
sends a reload-required signal and closes that connection. Updated clients expose
a localized reload action; unmodified old bundles receive the protocol close
reason and must be refreshed. Office and authenticated internal service writers
retain their existing protocol. This is capability negotiation, not a new auth
transport or a replacement for JWT/permission validation. Deploy the server first.
Capability negotiation alone does not authorize replaying an old whole-scene Save
from IndexedDB after reload. Browser sync updates that change an existing drawing's
immutable base/epoch, or revive a retired drawing under an unknown namespace, are
refused even with the current capability. Incremental element updates, ordinary
moves and independent new block IDs remain supported; internal validated scene
replacement is service-authorized. A distinct recovery notice keeps this page
read-only and lets the user copy local content, then explicitly confirm clearing
only this page's local cache and reloading server state. Nothing is auto-discarded.

Malformed registers are isolated to their drawing. Canonical snapshots retain an
explicit `collaborationError: invalid-registers` marker and no preview instead of
throwing out whole-page persistence. Raw CRDT state is retained for diagnosis;
editing that drawing is blocked until a validated scene replacement retires its
namespace. Valid neighboring blocks remain readable. Passive read-access revocation
is inherited: the inbound-message gate does not disconnect an idle reader merely
because its permission changed; this change does not add a proactive revocation bus.

Authenticated collaborative Pages use their existing page Y.Doc and Hocuspocus
provider for live drawing edits. Close dismisses the editor, not its shared edits;
there is no discard promise. The standalone non-collaborative editor retains its
Save/Cancel contract described below. Offline edits use the page provider's existing
persistence/reconnect policy, not a new transport or a separate durability promise.
Title edits commit on blur (including Enter or clicking Close). Escape in the
name input returns to the current shared title without undoing a remote rename.
Shape gestures and background changes publish immediately, including intermediate
drag geometry before release. SDK comparison baselines are detached snapshots,
never references to SDK-owned mutable elements. Remote updates preserve locally
active selected, resizing, new and text-editing elements (including bound text),
then reapply the canonical register winner on gesture completion. Other elements
continue updating during a local gesture; remote renders never author deltas.
View/tool state stays local. PNG generation is debounced while the editor is mounted;
closing before it completes leaves an explicitly unavailable preview, never a
stale image presented as current. Opening the editor retries generation.

Drawing presence uses only the existing page provider awareness `drawing` field,
scoped by the full drawing namespace (block ID, epoch and immutable base identity).
It is transient: no Y.Doc, IndexedDB, snapshot, preview or API writes. Peers are
keyed by awareness client ID, not account ID, so separate tabs remain visible.
The existing page `user.name` and `user.color` supply SDK username and colors;
no avatar, email, token, scene content or additional profile data is copied.
Excalidraw 0.18 accepts the color fields in its public collaborator type but its
canvas renderer derives cursor/selection hues from client identity; this change
does not fork that renderer to force exact host-page color parity.
SDK `onPointerUpdate` supplies scene coordinates and button; `onChange` supplies
selection and active editing IDs. Updates coalesce at 50 ms and deduplicate.
Only editors of the same current namespace render in the SDK collaborators map.
Close, unmount, route/epoch change, permission loss and disconnect clear just the
drawing field, preserving host page cursor, identity and all other awareness.
Disconnected editors show no remote collaborators; reconnect publishes fresh
presence. Abrupt remote loss uses the provider's awareness removal/expiry.
Presence is untrusted advisory UI, never a permission or element lock. Validate
finite coordinates bounded to +/-10 million, scope <=512 characters, names <=200,
hex colors, and at most 256 selected IDs of <=128 characters. Oversized arrays are
rejected before traversal; unknown fields are discarded rather than forwarded.
No new UI labels are introduced.

The embed scene is an immutable fallback. A per-drawing Y.Map stores element-ID
overrides, separate deletion tombstones, immutable file IDs, background and title.
Missing overrides read from the fallback, so concurrent first opens never seed
competing maps or resurrect deleted fallback elements. Same-element concurrent
writes use Yjs register resolution; deletion wins over concurrent geometry edits.
Ordering uses SDK fractional indices with deterministic fallback order. Files are
retained for undo and projected only for live image references. Scene replacement
selects a fresh embed epoch plus base-scene namespace; old editors cannot write into
the replacement. This namespace is an identity, not an authorization boundary.

The canonical snapshot decoder projects these registers into ordinary drawing
blocks, including nested drawings. JSON/API/serialization readers therefore see
the live scene, not stale attrs or an orphan side map. The browser embed uses the
same projection without writing it back to ProseMirror on every gesture.
Duplicate and clipboard serialization materialize the same canonical scene before
copying. Drawing clipboard copies and Duplicate assign fresh drawing block IDs;
non-drawing clipboard identity is unchanged. Drawing cut/paste is copy plus delete;
use the block Move action to retain identity and the existing live namespace.
Ordinary drag-move serialization also retains the original base and identity;
it must not look like a legacy whole-scene replacement to the protocol gate.
Ordinary node moves retain their existing namespace and do not reseed the scene.
Explicit AI scene replacement uses canonical blocks; title edits use the metadata register.
Deleting a block makes its registers unreachable and disables an open editor.
Every browser mutation rechecks edit authority, route/lifetime and block identity.
The sync server also rechecks the existing RLS page-access/grant gate before each
inbound page message, as it already does for Office. A connected tab is not a
permanent write grant: downgrade makes it read-only; lost read access or page
deletion rejects the message. Service-authenticated internal operations retain
their existing upstream authorization contract.
The existing provider's authenticated scope and stateless page-write-denied/allowed
notifications disable/restore the page editor, including closing an open drawing.
They do not erase rejected offline changes from local persistence.

SDK notifications publish only changes since that SDK last observed the scene;
remote reconciliation never echoes a whole scene into the map. Remote scenes use
SDK restoration/reconciliation, with Yjs as the same-element conflict authority.
Drawing Undo/Redo is scoped to the local drawing transaction origin, never the
whole page or a remote scene replacement. Preview exports are derived, digest-bound
and installed only if their source scene is still current; a stale export is
unavailable rather than evidence of a newer scene. Validation failures are visible.
New local writes validate the merged result against the scene limits. A union of
individually valid offline edits can exceed those limits: preserve that complete
canonical scene and Yjs binary in snapshots rather than failing page persistence
or silently dropping shapes/files. The live editor shows the size error and permits
removal to return below the limit; Brian can also replace that block's scene through
the existing scoped operation. No further over-limit local state is published.
Preview/export and bounded interchange validation remain unavailable until repaired.
Deletion tombstones remain in the CRDT, not the canonical live element array, so
deleting shapes actually reduces the scene's element and byte counts.

Regression coverage must exchange concurrent updates between two real Y.Docs,
including first edits, independent elements, same-element conflicts, deletion,
undo, files/metadata, persistence/reopen, replacement and unrelated page edits.
Real SDK/browser coverage is separate from pure CRDT convergence evidence.
Run `node apps/app-web/scripts/drawing-collaboration-browser.mjs` with the same
`PLAYWRIGHT_MODULE` / `CHROMIUM_EXECUTABLE` options as the other drawing browser
checks. It mounts two actual SDK clients in StrictMode and exchanges real Yjs
updates while disconnected, then checks convergence, keyboard Undo, redo, delete,
shared title, reopen, quiet update state and permission/replacement shutdown.
It then connects both SDK clients to an isolated local Hocuspocus server over real
WebSockets (no direct-exchange helper in this phase), checking canvas cursor-label
painting, dashed remote selection painting, two intermediate drag positions while
the other mouse is held, simultaneous distinct/same-element drag protection and
convergence, nonpersistent presence, separate drawing/epoch isolation, Close,
permission/route/unmount cleanup and disconnect/reconnect. Both clients use the
same synthetic account identity to verify separate-tab presence.
The server runs in-process and shuts down normally. Doc-sync pins upstream
Hocuspocus 4.2.0, whose `finally` cleanup fixes the per-packet scratch-awareness
timer/document leak in 4.1.0. Both standalone and platform-absorbed locks must
resolve the fixed version; see `docs/collab-runtime.md` for the lifetime regression.
This is actual WebSocket/SDK evidence, not an authenticated RLS/JWT or IndexedDB
deployment test. Mouse coverage does not prove touch/pen or network-partition expiry.

Excalidraw drawings are an OSS Page feature, not an Office document feature.
The slash menu offers Drawing (aliases: draw, sketch, excalidraw). The inserted
empty embed offers an explicit editor button. Collaborative Pages use the live
contract above. In the standalone editor, Save commits one complete scene;
Cancel discards that local draft without changing the block. Existing drawings
show a scene-derived canvas preview and can be reopened for editing.

The host page's inline formatting bubble and touch Comment chip stay unmounted
while a drawing draft is open, including lazy loading, nested library browsing,
and failed saves. Closing, successful Save, scope changes, or unmounting releases
this editor-scoped suppression; ordinary text selection formatting works again.
Single-node selections (including the drawing frame before opening) do not show
inline formatting. Drawing dialog keyboard and wheel events stay inside the
modal. Pointer and mouse down/move/up/cancel events and ordinary click/double-click
events must not be stopped at the modal boundary: Excalidraw 0.18.0 starts gestures
on the canvas but finishes them in bubbling native window pointerup listeners.
Blocking release leaves cursorButton down, the marquee live, and gesture move
listeners installed. Host toolbar suppression belongs to DrawingToolbarProvider,
not event isolation; narrow library import/browse interception remains intentional.
The browser regression must exercise a single left click followed by no-button
movement, marquee and shape drags (including release outside the canvas), and
verify released SDK state and stable geometry/selection after further movement.
This contract is shared by desktop and mobile; it does not change page content,
selection, edit permission, or drawing Save/Cancel semantics.

Run `node scripts/drawing-pointer-browser.mjs` from `apps/app-web` with Playwright
and Chromium available (or set `PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` to
external installs). It mounts the actual modal/SDK and a real host BubbleMenu
under the scoped provider in StrictMode, without auth or catalog network calls.
`DRAWING_BLOCK_RELEASE=1` is a negative control: reinstating the release blocker
must fail the first single-click assertion with cursorButton still down. The
jsdom test checks event delivery to window and toolbar lifecycle only; it is not
evidence of real canvas gesture completion. Browser coverage is desktop mouse;
touch/pen cancellation and native window focus loss are not simulated.
The same browser regression checks the hidden empty menu and nested catalog's
backdrop, bounds, border/shadow, phone targets, and Escape/draft retention in both
themes at desktop, phone and landscape sizes. Set `DRAWING_SCREENSHOT_DIR` to an
existing directory to capture these catalog states.

Drawings have an optional `title`, trimmed and limited to 200 characters.
Missing or blank titles render the localized Drawing fallback. The existing
editor's top-left title is the only name input, with a localized accessible label
and a proper dialog heading. Enter blurs without saving; Escape reverts the edit
since focus and blurs without dismissing the editor. Long names shrink within the
header; read-only and busy states disable editing. Name and scene remain local drafts until
Save, and Cancel preserves both saved values. The embed header, preview accessible
name, and editor accessible title show the drawing name. Read-only viewers cannot
rename. Title-only saves preserve the scene and its existing PNG export; the
preview digest covers only the scene, never the title.
The canonical block schema, API and Yjs carry the title. Brian can read it with
`getBlock` and rename with `patchPage`'s existing edit operation and a
`patch: { title: "Architecture sketch" }`, without resending scene or preview.
Page outlines include the actual title before the element-count summary.

New text defaults to Normal (Excalidraw's Nunito font) whenever an empty or saved
scene is opened. This editor-only default preserves the scene's existing app
state and does not change existing text or its fonts. Save still persists only
the canonical durable app-state subset, not the current text-tool font setting.

The custom SDK MainMenu has no actions. Its hamburger is hidden within this editor:
otherwise opening it renders only a tiny empty padded, rounded popup. Keep the
empty MainMenu override so the SDK does not restore its default file/link actions.
This does not disable image export or change Brian's Save/PNG preview generation.

## Libraries

Library parsing, validation and Brian default item generation are shared between
the browser editor and server consumers; item IDs and local-library migration
behavior remain identical across those consumers.

### Default Brian Assets

The bundled library contains 38 assets from https://usebrian.ai/brand/interns:
the bordered base logo, all 15 V1 accessories, and the 22 distinct V1 intern
discipline/accessory combinations across the four roles. Source filename stems
are retained as names and deterministic IDs; discipline, accessory, role and
source metadata live on each grouped asset's background rectangle.
`drawing-default-library.ts` derives sharp, solid Excalidraw geometry from the
pixel data in the platform's `apps/web/src/lib/brand-mascot.ts`. Geometry matches
the 512px downloads, scaled to 160px, including navy tiles, eyes and discipline
pins. Bordered cells use a 1-unit inset at that native size (2-unit shared grid
edges), matching the marketing renderer's output-size border rule rather than
scaling its 1px inset down to 0.3125 units. The old subpixel gaps render unevenly
through Excalidraw's per-element canvas caches at fractional sizes; SVG library
thumbnails do not exercise that path. The borderless logo is not included.
No marketing runtime dependency or network fetch is needed.
The ten V2 poses use curves, gradients and glow rather than pixel grids and are
deliberately not approximated. This does not add raster library support.

Initialization merges defaults with saved items by stable ID/content, preserving
existing entries. Items and a defaults-seeded marker are written atomically in
the existing API/account/workspace storage key. Legacy saved arrays remain
readable. Ordinary reads and editor updates never seed; after successful seeding,
deleting any or all defaults survives reopening. Explicit reimport is supported.
Seed version 4 removes only exact unchanged built-in borderless entries from
previously seeded V1, V2 or V3 libraries during initialization. Legacy geometry
is retained only to recognize those persisted seeds. Edited entries and copies
with different IDs remain; stale editor writes cannot restore an unchanged removed
seed. Present, exactly unedited older bordered items are still repaired in place
with the same IDs and order. Name, metadata, geometry,
style, element order or other content changes exclude an item from repair; no
missing item is recreated. The version and items are written atomically and
ordinary preference writes retain the version. Existing drawing scenes are user
content and are never migrated; replace an already-inserted old logo explicitly
from the repaired library if needed.
If adding defaults would exceed the byte, item or element limits, initialization
returns the valid existing library without writing storage or marking it seeded.
Existing items remain available in the editor; a later initialization retries
seeding after capacity is freed. Invalid saved data and storage/quota failures
remain errors and never overwrite saved items. Regression coverage lives in the
existing `[COMP:app-web/drawing-library]` unit and real-SDK suites.
The network-free `node apps/app-web/scripts/drawing-default-library-browser.mjs`
regression samples all 44 shared bordered base-logo edges on the mounted SDK's actual
cached canvas at 160, 173, 240 and 320px, at device pixel ratios 1 and 2. It uses
the same external Playwright/Chromium options as the catalog browser test below.

### In-App Catalog Contract

Both web catalog paths share a bounded dialog with an opaque theme-token surface,
a contrasting scrim and blur, a visible token border/ring, and a deep shadow.
The backdrop explicitly renders for this nested Base UI dialog (nested backdrops
are otherwise omitted by the primitive).
The panel keeps an 8px phone gutter (32px on larger screens), is capped at 72rem
wide and 56rem tall, and uses dynamic viewport height. Rounded edges clip the
iframe; catalog content scrolls internally without exposing the drawing through
the panel. Close/import targets remain touch-sized and search uses 16px text on
phones. Nested focus trapping, close/abort behavior and the mounted draft remain
unchanged.

Local-origin Web Browse uses a first-party searchable catalog inside the drawing
dialog. All plain HTTP origins, HTTPS localhost/.localhost, single-label/local
hostnames, loopback and private IPs use this path. Brian fetches the official
`libraries.json` directly in the browser with no credentials, referrer or redirects,
bounded to 2 MiB and 2,000 rows. Zod validates bounded names, author names and
relative library source paths; metadata is text only, not HTML, links or scripts.
The optional publisher `preview` path is validated independently: invalid or missing
paths fall back without rejecting the catalog. Only canonical HTTPS images under
the official `/libraries/` path are used (no credentials, query, fragment, encoded
paths or traversal). One bounded-size native lazy/async image per row shows a
representative preview, not necessarily every item, with no referrer and a localized
missing/broken-image fallback. No SVG markup is injected or scenes restored for
browsing; library installation remains an explicit Import action.
Search matches names/authors. Selecting Import fetches its canonical allowlisted
library URL through the existing importer, with the same session, route, close,
permission and dedup guards. No iframe, callback navigation or postMessage is
needed. Catalog failures offer an in-panel Retry; import errors preserve the list
and drawing. Desktop retains Download/Import until verified in actual Electron.

Public HTTPS Web Browse embeds the official catalog in a nested, themed, responsive
dialog. The editor and its scene/title draft stay mounted. The sandbox permits
only scripts and same-origin identity, not popups, downloads or top navigation.
Add uses `target=_self` and a dedicated public static callback document (no app,
auth provider, private content or API endpoint). The referrer contains no account,
workspace or page identifiers. The parent holds a random 128-bit browse token,
passes it through the catalog protocol, and never persists it. The callback posts
to its exact own HTTP(S) origin; the parent
checks that origin, iframe window identity, strict payload, token, current route,
editable authority and lifetime before fetching an allowlisted library URL.
Closing, unmounting or losing edit permission aborts the import. One selection is
accepted per panel; reopening creates a new token. Success closes the catalog and
opens the SDK Library panel without replacing the drawing. No tab focus is needed.
The unshipped named-tab, checkpoint and BroadcastChannel protocol is removed.

Live HTTP HEAD and Chromium GET on 2026-09-09 returned 200 with neither CSP nor
X-Frame-Options. The real catalog rendered in the sandbox and Software Architecture
Add preserved the callback and `_self` target. Its font request currently has an
upstream CORS failure, independent of embedding. Chromium Local Network Access
blocks a public iframe navigating back to localhost. The first-party local picker
avoids that navigation entirely: local-to-public JSON fetches are allowed. This is
not a blanket limitation on localhost imports. Public HTTPS deployments with
restrictive framing policy can still require Download/Import.
The UI always offers close and manual-import guidance; iframe load cannot prove
cross-origin content rendered, so it must not claim a network success. Desktop
keeps its explicit external Download/Import flow; opaque/null origins are rejected.

The callback document has a hash-pinned script-only CSP (`default-src 'none'`),
no external scripts, and no app/auth mount. The external catalog is cross-origin;
`allow-same-origin` preserves its origin instead of granting access to Brian.
After navigation the frame is Brian-origin, where only the pinned callback runs.
Do not put private content or arbitrary scripts in this document: combining
scripts and same-origin would allow a compromised same-origin document to remove
its sandbox. The callback never accesses the parent DOM, opener, API or storage.
The parent is the only library fetcher and preference writer. No API permissions
are bypassed, and no Brian cookies, credentials or private route IDs are sent to
the catalog. Catalog-owned third-party cookies remain browser-controlled.

The catalog's `script.js` (upstream blob
`7de6b11fd5b9b6fc697c0d566383368c6eafe0e7`, verified 2026-09-09) reads the
explicit `referrer` query, not the HTTP Referer header. It appends
`#addLibrary=...&token=...` for `useHash=true`, accepts the callback without host
registration and preserves it through sorting/theme changes. Unknown apps retain
the label "Add to Excalidraw"; that label does not determine the destination.
No-referrer policy therefore does not break the return protocol. If privacy
software strips the query, Brian does not accept an uncorrelated return.
The SDK Browse link is replaced; Load and library file drops use Brian's bounded
importer. This uses `updateLibrary`, not the SDK's unbounded `useHandleLibrary`.

The network-free catalog regression executes the full MIT-licensed catalog HTML
and script and validates its real Add anchors. Opt into live fixture/header
verification with `LIVE_EXCALIDRAW_CATALOG=1 pnpm --filter app-web test
src/components/doc/__tests__/drawing-library-catalog.test.tsx`.
Run `node apps/app-web/scripts/drawing-library-browser.mjs` for the real browser
regression (requires Playwright/Chromium; `PLAYWRIGHT_MODULE` and
`CHROMIUM_EXECUTABLE` can point at external installations). It starts an isolated
Vite harness with a temporary cache and an unused local port. It loads the real
HTTP localhost parent and fetches the actual official index and artwork without
request interception on the success path. No Next cache or user server is touched.
The harness uses the canonical collaboration singleton resolver. Set
`DRAWING_SCREENSHOT_DIR` to an existing directory for desktop/mobile editor and
catalog screenshots (defaults to the OS temporary directory). Chromium 150 on
2026-09-10 verified loaded publisher previews (`naturalWidth > 0`), no install or
library fetch while browsing, Enter/Escape title edits, long-title mobile layout,
seven-item repeat-import deduplication, and scene/title retention. The isolated
Linux harness needs system fonts; its fallback typography is not the Next font.
Chromium verification on 2026-09-09 at `http://localhost:5173` passed: searching
Software Architecture and selecting Import imported seven rendered library tiles and
41 elements twice without duplicates or extra tabs, retaining the same SDK,
unsaved title and scene. The SDK's add-selection control is not an imported tile.
The browser test also covers mobile width, closing without losing the draft, and
blocking the index request followed by successful in-panel Retry. The live index
had 232 rows / 200,318 bytes with `Access-Control-Allow-Origin: *`. Local-to-public
fetches worked with Chromium's normal security settings; no LNA bypass was used.

Libraries are a device/browser-local preference scoped by API target, account
and workspace. They are NOT cross-device synced or workspace-shared. Library
changes persist independently of drawing Save; inserting an item remains a
scene draft until Save. Initial empty SDK notifications never wipe storage.
Imports preserve explicit item IDs. Missing item IDs are derived from canonical
validated elements and the optional item name before SDK restoration, using a
128-bit FNV-1a content hash (an identity, not an authorization token). Object key
order, import time and publication status do not affect this identity; element
order and IDs are preserved. Repeated imports across browse sessions retain one
copy, even when SDK restoration regenerates legacy element version nonces.
Deleting an item locally does not tombstone it: explicitly importing it again
restores it. Different content remains distinct, including different geometry
with the same element IDs/version nonces. The merge also deduplicates canonical
item content rather than comparing only element IDs/version nonces.
Limits: 2 MiB UTF-8 per import and stored library, 500 items, 5,000 total
elements. Library assets/images, links and executable embeds are not supported;
the existing scene validator validates each item's geometry before restoration.
Official v1 arrays and v2 item records are accepted, including legacy nullable
`boundElementIds`. Missing v2 item IDs receive the same content-derived identity;
status and creation times receive the SDK's import defaults. Imports must contain items, and SDK
restoration must retain every validated item and element before persistence;
empty or unsupported data gets a specific error, never an installed notice.
Initial preferences use the SDK's queued imperative replacement after Brian's
default/saved-library merge, not a second copy in
scene `initialData`. Only a correlated iframe callback grants library import.
The real-SDK StrictMode regression mounts the editor, sends an iframe callback,
checks rendered library tiles, then closes and reopens to verify persistence.
Run `LIVE_EXCALIDRAW_LIBRARY=1 pnpm --filter app-web test src/components/doc/__tests__/drawing-library-sdk.test.tsx`
to also fetch official v1/v2 payloads and run them through that mounted SDK flow.
The normal run is network-free; jsdom shims only drawing/font browser APIs, not
Excalidraw's library restoration, update queue, callbacks or rendered library UI.
Successful SDK cases reopen the editor and import the same payload through two
new browse sessions, retaining the same stored IDs and tile count, then import
a different library and verify it merges. The optional Software Architecture
case uses the exact live seven-item payload; the protocol suite also checks a
seven-item missing-ID fixture, deletion/reimport and canonical key ordering.
The 2026-09-09 payload investigation reproduced rejection of official Snowflake,
Gadgets, Charts, Forms and Medias libraries on `boundElementIds: null`; allowing
the SDK-supported null value repaired those validation failures. The mounted
SDK test did not reproduce an initialization overwrite or lost confirmation
with valid data. This does not identify an unspecified catalog selection.
Software Architecture (`youritjang/software-architecture.excalidrawlib`, live
catalog ID `mzQjGLHnDi`) uses the legacy `draw` element type. At the library
import boundary, Brian migrates this type to `line`, matching Excalidraw 0.18's
restoration, then validates all geometry and unsupported fields as usual.
This does not add a new canonical Page element type or relax scene validation.
The live optional SDK test includes this exact seven-item library; the offline
regression uses a synthetic legacy stroke rather than vendoring catalog artwork.
The earlier Chromium investigation reproduced rejection before migration and
seven stored/rendered items afterward. The 44,591-byte payload has 41 elements, including seven
legacy strokes. Published imports render under **Excalidraw Library**; the
separate **Personal Library** may still say "No items added yet". That message
does not describe the published section. No callback/controller or SDK queue
change was needed for this reproduction.
Malformed data, failed fetches, unavailable storage and quota errors are visible;
failed persistence leaves existing stored items intact. No server fetch or sync
endpoint is added. Remote imports accept only HTTPS `.excalidrawlib` files under
`https://libraries.excalidraw.com/libraries/`, without credentials or redirects.

Desktop one-click return is NOT supported. Browse opens the official catalog
without a return URL; download an `.excalidrawlib` and use Brian's Import library
button. The bundled `file://` route and existing `usebrian://open` deep link are
not library callbacks. The same bounded validation and local preference apply.
Read-only blocks do not load preferences or handle library callbacks.

## Persistence and Authority

`drawing` is a member of the canonical core Block/schema union. Its versioned
scene contains elements, a small durable app-state subset, and embedded raster
files. An optional derived PNG preview is persisted alongside the scene, never
as its authority. Browser Save exports a light-mode PNG using the scene's
background (at most 1600 px per side and 1 MiB of PNG file bytes), bound to the canonical
scene by SHA-256. Empty
scenes save without a preview. Export failures leave the draft open without
committing. The existing embed JSON attr, ProseMirror transactions, Yjs encoding,
server snapshots, and Page add/edit/delete
operations carry the same block. Brian can read and replace scenes with those
existing selection/block-ID scoped operations; no human-only storage or new tool
is introduced. Ordinary page authorization remains authoritative on the server.

Brian's targeted `getBlock` read delivers a valid export as actual model image
content through the existing tool-result image channel, for both the parent
assistant and delegated document editor. Bulk reads do not attach images. Tool
text excludes preview bytes and embedded raster bytes; file metadata remains.
Do not reconstruct omitted file bytes when editing. Missing, invalid, or
scene-mismatched exports are explicitly unavailable, not evidence of the drawing.
Before declaring an export available, the server checks all chunk lengths and
CRCs, bounds IDAT inflation by the validated image dimensions, and fully decodes
and re-encodes the pixels with the existing image decoder. Ancillary metadata is
not decompressed or forwarded. Invalid PNGs leave the canonical scene readable
but the preview unavailable. The regenerated PNG must also fit the 1 MiB cap.
The pixel limit is 2,560,000; the IDAT inflate cap is derived from dimensions
and never exceeds 20,492,800 bytes (16-bit RGBA plus interlace filter overhead).
Bulk block arrays are decoded serially rather than allocating for every drawing
concurrently.
AI scene edits invalidate the previous preview. New AI drawings and older scenes
need a browser editor Save before visual reading; there is no server-side renderer,
background mutation from read-only rendering, or remote image fetching.
Text-only providers cannot visually read the attachment. Each targeted read adds
at most one image; ordinary text-result truncation does not truncate image bytes.
The existing executor caps tool text at 25,000 estimated tokens; scene geometry
can still be truncated at that limit. Context fitting currently estimates 1,000
tokens per image (actual provider usage varies) and may evict old messages. A
fresh targeted read restores the visual evidence when needed.

Save checks current editor authority and the original node's identity/content
immediately before dispatch. A remotely changed or deleted block rejects the
save rather than replacing another block. This is optimistic protection, not
scene-level multi-user merging: simultaneous offline saves remain Yjs last-writer
wins. Drawing gestures and Undo stay local until Save; Cancel never writes.

## Safety and Delivery

Scenes are limited to 2 MiB serialized UTF-8 and 5,000 elements. Image assets
must be inline base64 PNG/JPEG/WebP/GIF; remote URLs and SVG assets are rejected.
Every live image must have its file. Unsupported or oversized scenes fail visibly,
never silently dropping images. Preview is exported to canvas, never injected SVG.
Save filters Excalidraw's retained file map to live image references before
validation; deleting an unsupported or oversized image therefore allows saving
again without accumulating unused assets. Linear elements require at least two
finite coordinate pairs; freehand elements require points and pressure settings,
with matching pressure samples when pressure is not simulated. Text requires
text/font metrics. Optional binding, crop, scale, and elbow-segment geometry is
validated when present before Excalidraw restoration.
Editor code loads client-side on demand; bundled fonts are served locally in both
Next and desktop builds. The dialog uses the app theme, en/ja/zh translations,
focus trapping, responsive sizing, and explicit Save/Cancel controls.

## Integration Constraints

Deploy shared/core, doc-model, doc-sync and the UI together, and refresh existing
browser clients. Older drawing editors do not project the live registers and their
whole-scene Save is not a collaborative writer. No database migration is required.
Markdown/Office exports are not editable Excalidraw interchange; the canonical
Page JSON is the lossless interchange. The platform lockfile and external docs
mirrors are outside this worktree's scope and must be integrated separately.
