# Application SDK and scaffolds

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
contract. Query results retain the page envelope (`records`, optional `nextCursor`
and aggregate entries with lossless string or null values), including all evidence.
Schema governance uses explicit native-management `schemas` ports;
absent ports fail `operation_not_available`. Application credentials never become
native schema authority. No helper computes permission from a grant.

In a trusted Node deployment, supply an authenticated native-management fetch:

```ts
import { createNativeSchemaPorts } from '@use-brian/brian-app/module'
const schemas = createNativeSchemaPorts({ apiOrigin: 'https://brain.example',
  workspaceId, fetch: authenticatedNativeManagementFetch })
const review = await schemas.preview({ typeId, expectedVersion: 1, properties, assistantId }, { signal })
if (review.canApply) await schemas.apply({ previewId: review.id, assistantId }, { signal })
```

These ports also implement `createApplicationClient({ appId, transport, schemas })`.
Preview calls `POST /api/applications/workspaces/:workspaceId/schemas/:typeId/preview`
with `{ expectedVersion, properties, assistantId? }`; apply calls
`POST .../schema-reviews/:previewId/apply` with `{ assistantId? }`. Properties use
the canonical core `PropertyDef` type; schema versions are numeric, while record
versions remain opaque strings. Preserve review metadata and validity counts.
The server authenticates the native actor and selects a visible assistant; the SDK
does not send user IDs or roles. Keep the authenticated fetch in the trusted
deployment, outside static application bundles. Review creation and apply both
persist state; interruption is uncertain and does not trigger a retry. Reconcile
the same saved review under fresh current authority before deciding what to do.

`ApplicationSdkError` exposes `code`, `effect`, `retrySafe`, `status` and
`cancelled`. Returned objects are preserved intact; there is no persistent cache,
optimistic permission widening or automatic retry. After dispatch, a disconnected
or cancelled write is uncertain. Reconcile using its idempotency key/receipt
before deciding to retry. HTTP error bodies and transport exception details are
never included in SDK errors.
Credential suppliers receive optional call options containing the operation's
AbortSignal. Cancellation while waiting for browser, service or delegated
credentials rejects promptly before dispatch with effect `none`. Late credential
results are ignored; no authentication or operation is retried automatically.
Existing suppliers may continue to ignore the optional call options.

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
Starting another login or calling `cancel()` invalidates an earlier pending PKCE
generation. Late digests cannot replace the newest proof, and a cancelled or
superseded exchange cannot return a token after response-body decoding.

Home uses `createHomeApplicationTransport({ appId, homeAppId, workspaceId,
apiOrigin, hostOrigin, window })`; its `transport` requests the existing signed
Home bridge token via `ub:ready`/`ub:token` and checks parent-window identity,
exact host/API origin and Home/workspace binding. Call `dispose()` on unmount;
pending requests fail explicitly. Backend qualification still holds binding
issuance unavailable. Never substitute a native JWT or service key.
Opaque Home Origin `null` is admitted by the backend only for an active Home
client using the signed Home profile. The SDK never overrides Origin. Budget
denial preserves status 429 and safe effect/retry metadata without retrying.

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
the platform repository; OSS guide: `docs/applications/sdk.md`. R2 runtime QA,
R3 retained evidence/cache integration, R5b management, R5c real reference journeys,
R6 qualification and all publication, production setup, trust provisioning, live
provider QA and independent-source adoption remain owed.

Cancellation while consuming an effect response remains uncertain. Already-aborted
schema operations never invoke their injected deployment port.

### Existing lifecycle identity

A deployed module can add its application operations to a lifecycle-only entry in
the supplied registry. Keep the same key and default state; omit the existing
blocker compatibility mapping to inherit it, or supply the exact same mapping.
Conflicting metadata and a second application registration are rejected. Existing
persisted state and the lifecycle blocker adapter remain authoritative.
