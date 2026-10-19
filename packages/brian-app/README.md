# @use-brian/brian-app

OSS bundle validation, browser application client and deployed module/source kits.
R5a conformance is local package evidence. Runtime qualification remains false;
this package does not activate protected operations or certify consumers. The
profiles and private canonical type packages are not claimed registry-installable
before R6/publication.

| Export | Environment | Purpose |
|---|---|---|
| `@use-brian/brian-app` | Node or browser | Existing manifest/bundle validation |
| `@use-brian/brian-app/application` | Browser | Typed application client, safe errors, app-bound PKCE and Home adapters |
| `@use-brian/brian-app/module` | Node only | Canonical module/registration types; service/delegated credential transport |
| `@use-brian/brian-app/connector` | Node only | Ed25519 actor verifier and independent source protocol helpers |

Canonical types come from shared/core through erased type imports. Deployments
supply matching canonical packages; the browser runtime graph contains neither
root. Deployed registration uses the host's `defineApplicationModules` and the
canonical service. No uploaded code registration or central ACL edit is required.

From the OSS root, with installed local tooling:

```sh
pnpm --filter @use-brian/brian-app build
node packages/brian-app/bin/brian-app.js scaffold --profile native output/sdk-native
node packages/brian-app/bin/brian-app.js scaffold --profile connector output/sdk-source
node packages/brian-app/bin/brian-app.js output/sdk-native
node packages/brian-app/bin/brian-app.js lint output/sdk-native
pnpm --filter @use-brian/brian-app test
```

Scaffolds require an empty destination and reject traversal, symlinks and unknown
profiles. With the matching local packed packages/toolchain provided, run
`npm run build` and `npm run contract` inside either generated directory. Tests
perform this outside the workspace without registry or global installations.
The native HTML is a placeholder for bundling `src/browser.ts`; configure the
server module and build the browser assets with your normal browser bundler.

```ts
import { createApplicationClient, createFetchTransport } from '@use-brian/brian-app/application'
const client = createApplicationClient({ appId: registeredAppId,
  transport: createFetchTransport({ apiOrigin: 'https://brain.example',
    credential: async () => inMemoryAppOAuthToken }) })
const record = await client.get('request', 'synthetic-id', { signal })
// record.ref.version is opaque; preserve fields, source evidence and receipts.
```

Helpers map to `/api/applications/:appId`: `catalog`, `schemas/:type`,
`records/:type/:id`, `records/:type/query`, `records/:type/:id/history`,
`queries/:queryKey` (registered input), and `commands/:commandKey` (shared
idempotency/version/input envelope). Query defaults/types are the shared wire
contract. Schema preview/apply uses explicit `schemas` deployment ports while R2
freezes its route contract; absent ports fail `operation_not_available` without
sending a guessed request. No helper computes permission from a grant.

`ApplicationSdkError` exposes `code`, `effect`, `retrySafe`, `status` and
`cancelled`. Returned objects are preserved intact; there is no persistent cache,
optimistic permission widening or automatic retry. After dispatch, a disconnected
or cancelled write is uncertain. Reconcile using its idempotency key/receipt
before deciding to retry. HTTP error bodies and transport exception details are
never included in SDK errors.

Standalone login uses `createApplicationSignIn`: keep the originating page alive,
open a popup, call `begin({ popup })`, and navigate that popup to `authorizationUrl`.
The registered callback page posts `{ type: 'ub:application:callback', appId, url:
location.href }` to its opener using the exact app origin. Pass that MessageEvent
to `completeFromMessage`; it checks the bound window/origin/app, then consumes the
exact redirect/state/PKCE proof through the existing app-bound token route.
`complete(callbackUrl)` is for a trusted callback transport; `cancel()` discards
its one-use proof. Full-page navigation discards this memory-only proof, so use a
popup or a trusted server-side session adapter. Native sign-in/consent handles
same-origin sessions. Login alone supplies no records.

Home uses `createHomeApplicationTransport({ appId, homeAppId, workspaceId,
apiOrigin, hostOrigin, window })`; its `transport` requests the existing signed
Home bridge token via `ub:ready`/`ub:token` and checks parent-window identity,
exact host/API origin and Home/workspace binding. Call `dispose()` on unmount;
pending requests fail explicitly. Backend qualification still holds binding
issuance unavailable. Never substitute a native JWT or service key.

Service/delegated credentials belong only in Node `./module`. A delegated
credential requires app-bound user OAuth in `X-UseBrian-User-Authorization`; it
accepts no free-form user identity. Never log tokens, embed secrets/cookies/native
sessions in static assets or write them to localStorage.

A connector deployment must supply authenticated transport, exact trust binding,
public keys, durable atomic replay storage, source account/assistant mapping,
canonical per-record/field/recipient ACL callbacks and saved idempotency/effect
receipts. Unconfigured callbacks fail unavailable; unknown source mappings deny.
Capabilities must truthfully advertise retention modes and reconciliation.
Governed observations require current authorization, released snapshots require
independent release receipts and expiry, and ephemeral output requires a lane
that does not persist it. A valid Brian assertion proves identity, never business
permission. Reconcile uncertain effects; never retry automatically.

The dedicated spec is `docs/architecture/features/application-platform-sdk.md` in
the platform repository; OSS guide: `docs/applications/sdk.md`. R2 route completion,
R3 retained evidence/cache integration, R5b management, R5c real reference journeys,
R6 qualification and all publication, production setup, trust provisioning, live
provider QA and independent-source adoption remain owed.
