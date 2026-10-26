# Application platform reference applications

These are deployable examples for the open application platform. Capability
activation and current grants remain server decisions. Static clients and source
conformance do not certify runtime or whole-platform acceptance.

From the OSS root, with the already installed toolchain:

```sh
pnpm --filter @use-brian/brian-app build
node examples/application-platform/build.mjs output/application-platform/reference-web
node --test examples/application-platform/shared/browser-session.test.mjs examples/application-platform/external-source/source.test.mjs examples/application-platform/conformance/conformance.test.mjs
```

Serve `output/application-platform/reference-web` with your normal static server.
`operations/` and `portal/` are independent static entrypoints. Configure both with
the same Brian API origin and their own registered app/OAuth client, workspace and
resource type (`record.<canonical-schema-id>`). Register each exact callback URL
(the served index pathname) in Brian. Sign-in opens the existing Brian OAuth
consent window. Only public callback app metadata is placed in popup sessionStorage;
OAuth tokens and one-use PKCE proof remain in memory. No service key, native bearer
or free-form user identity belongs in either frontend. The portal needs a verified
nonmember Brian identity and explicit resource/field grants before it can read.
A real maintained-rig/browser journey remains separate evidence from these tests.

The browser clears protected output before reads and on denial, logout, expiry,
offline or hidden-page invalidation. Reconnect requires sign-in and a fresh read.
It rejects late responses from superseded invocations and never queues or retries
a write. An uncertain write holds its idempotency key until an explicit matching
current receipt resolves it. The session's reconcile callback must perform an
authenticated current server receipt read through the provided client; a local
caller assertion or cached receipt is not reconciliation. The UI reports the uncertainty; do not create another
order to guess whether the first one completed.

## Deploy the purchase module

`operations/module.ts` re-exports the deployed implementation in the open API
package at `application-platform/purchasing/module.ts`, never an uploaded manifest. Its only
runtime dependencies are canonical ports injected by the trusted API composition.
Create its three schemas through Brian's canonical schema API using
`purchaseProperties({requestTypeId,lineItemTypeId,orderTypeId})`. Requests and
orders link to the existing canonical CRM company ID; line items link to their
request. Register the deployed native module field contract and exact schema
ownership through the supported governance review/apply paths. Policy gives
`requester` and `manager` their required fields; costs and budgets remain protected.
Bind current roles with the existing reviewed role-assignment flow. Do not seed
per-actor authority or use an owner database connection to run the module.

The host's ordinary `bootOpenApi` composition supplies the existing module seam:

```ts
const purchasing = createPurchaseOperationsModule({
  requestTypeId, lineItemTypeId, orderTypeId,
  genericModule: createCanonicalGenericApplicationModule(),
  resourceForSchema: canonicalGenericResource,
  jsonInput: applicationJsonSchema,
  error: (code, message) => new ApplicationPlatformError(code, message),
  lockRecords: (context, ids) =>
    lockApplicationModuleRecords(context, 'purchasing', ids),
  authorizeRole: (context, role) =>
    assertApplicationModuleRole(context, 'purchasing', role),
})
await bootOpenApi(env, { /* existing deployment options */
  applicationModules: [purchasing],
})
```

Import SDK types from `@use-brian/brian-app/module`; the trusted host imports the
canonical generic adapter/resource factory, JSON schema/error and current module
role port from its matching API/shared packages. No example-local ACL or data store
is accepted. Use the normal rig for local app execution; a unit HTTP fixture is not
a replacement for that deployed composition. The explicit OSS `--admin-only --reference-applications` composition statically registers that same purchasing host factory; normal OSS and hosted entries omit it;
it does not create schema, role, grant or activation authority.
For multiple workspaces, `createWorkspacePurchaseOperationsModule` takes the same
canonical ports plus a required `resolveSchemaIds(context)` deployment reader. It
reuses one resolved module for authorize/execute/result within that invocation,
with no cross-execution authority cache. Bind that reader to explicit module-owned
configuration through the existing native configuration reader/handler and revision
contract. No workspace_modules configuration column or inferred schema-name mapping
exists. The deployed `configuration.ts` reader uses the module-owned data path in
`deploy.sql`; apply that versioned deployment through the installation migrator,
then review schema ownership, roles, configuration and activation through normal
governance before a workspace can run commands.

Commands are `create_request` (caller supplies request and line IDs, title,
canonical company ID, exact decimal budget, and 1-98 lines with title, integer
quantity and exact decimal unitCost), `submit_request` (`{ id }`, expectedVersion
in the envelope), and `approve_order` (`{ id, orderId }`, expectedVersion).
Approval reads admitted costs, enforces submitted state and budget, locks admitted
request/line identities and writes the request plus order in one canonical service
transaction. The service owns CAS/replay, revisions, audit and outbox. The module
publishes no raw record mutation command. Canonical owned-schema guards must also
cover legacy writers and concurrent line insertion; do not activate a deployment
that has not passed those guards and current schema/capability drift checks.

## Service and delegated client

`service-bot/client.mjs` uses the Node-only SDK service transport. In a trusted
server process, import it from the built output and supply a credential callback
that returns `{ kind: 'service', token }` or
`{ kind: 'delegated', token, userAuthorization }`. The latter token must be an
independently validated app-bound user OAuth token. No user-ID argument exists.
Current application/parent/credential/role authority still applies to each call.
There is no automatic refresh, retry or impersonation path.

## Independent source

`external-source/server.mjs` exports `createReferenceSourceServer`. It binds only
to loopback when its explicit `listen()` method is called. Deployment supplies an
independent persisted JSON state file, source tenant, authenticated transport
secret, pinned issuer/audience/workspace/connector public-key trust and an
`authenticateSourceUser` callback for its own UI session. Unconfigured callbacks
refuse. Build output supplies the local SDK package without a network install.
The source uses an atomic file lock, fsync and rename for its own single-host
account/ACL/replay/effect store; a multi-host deployment must replace that storage
with an equivalent canonical source transaction. A crash-held lock fails closed
and needs the source operator's recovery; Brian never bypasses it.

State shape is version 1 with `tenant`, `identities`, `accounts`, `grants`,
`records`, `releases`, `replays` and `effects`; the focused test provides fictional
examples. Identity mapping binds issuer, audience, workspace, connector instance,
actor kind/ID and assistant ID. A current source account and exact per-resource,
field, action and mode rights are required. The source UI and Brian HTTP paths use
the same source authorizer. HTTP reads use `{data,envelope}`. Explicit `model: true` on every selected field's current grant, together with context rights, is required for model use; the default is false. Snapshot model permission must be explicit on its exact release. Assertions are verified using public SDK Ed25519 and
durable one-use replay storage before source ACL evaluation. Endpoints are:

- `POST /usebrian/source/{capabilities,authorize,reconcile}`: SDK source protocol.
- `POST /records/read`: `{ type, id, fields, retentionMode }`.
- `POST /records/command`: `{ idempotencyKey, input: { type, id, expectedVersion, patch } }`.
- `POST /ui/records/read`: same selected read under an independent source session.

All responses are no-store and errors omit internal details. Read receipts bind
current resource/policy versions. Released snapshots require a source-created
release with exact audience, fields, actions and expiry. Ephemeral source output
creates no retained payload copy; this alone does not qualify a Brian model or
storage lane. Saved source effects reconcile once by the same identity and key;
replay must use a freshly signed assertion. Source account/field withdrawal blocks
current reads and reconciliation without granting another reader's independent
rights. Synthetic local identities are the only data in tests.

## Independent kit conformance

`conformance/second-module.ts` registers the unrelated `dispatch_notes` module
through the injected public SDK registrar. `second-source.mjs` uses the public
connector profile with a separate persisted source account/resource mapping.
The conformance test packs the real local SDK/shared/core packages, compiles both
module consumers outside the workspace, invokes the canonical deployed registrar
and checks signed second-source authorization/replay. It changes no central
allowlist and imports no purchase-module implementation into the second module.
No registry installation, paid provider, production identity or live trust setup
is performed. Publication, real deployment provisioning and whole-platform gates
remain separately owed.

## Build and configure the explicit purchase reference

The source-owned deployment contract is `operations/deploy.sql`. Apply it once
as the installation migrator after the platform migrations. It registers private
ports and the typed configuration operation; it seeds no actor, role or app grant.
For a workspace, use native management governance review/apply to assign each
initial `requester`/`manager` role to the current workspace owner before binding
any schema. Create the three canonical schemas through `POST /api/entity-types`
with the exact `purchaseProperties` definitions (create request first, then use
its returned ID in the line-item/order relations). Review/apply `bind_owner` for
each schema, then `configure` with `operationKey: 'set_schemas'` and exactly
`{ requestTypeId, lineItemTypeId, orderTypeId }`. Configuration changes advance its
private revision and invalidate earlier activation and execution snapshots.

With existing installed dependencies and matching package outputs:

```sh
pnpm --filter @use-brian/api build
node examples/application-platform/build.mjs output/application-platform/reference-web --module
```

The optional `--module` build emits a separate server artifact under
`output/application-platform/reference-module/dist/` with real declarations. It
copies only the fixed reviewed TypeScript host/module/resolver sources, compiles
them with the installed compiler and links existing workspace dependencies; it
does not install packages or load executable configuration. The browser output
remains separate.

Normal OSS and hosted boot do not register purchasing. Build the API-open entry
and select `scripts/rig-up.sh --admin-only --reference-applications` for the fixed
reference host. To switch a running owned administrative rig, first use
`scripts/rig-down.sh --admin-only --keep-db`; normal/reference receipt mismatches
refuse warm reuse. Keep the same app, schemas, roles, bindings and receipt IDs;
do not rerun deployment/configuration SQL to switch hosts. Current authority and
configuration still apply. Static frontend output alone is not browser proof, and
the administrative reference mode starts no paid providers or workers.

A member frontend registers `purchasing` in `external_frontend` mode, reviews and
applies `canonical_module_frontend_v1`, and receives explicit member grants for
its owned schemas and semantic commands. It also needs an exact canonical company
identity grant with `read`, empty read/write fields and the allowed company IDs.
Complete genuine PKCE consent under that member; the native browser session never
becomes an app bearer. Nonmember semantic roles and delegated keys remain held.

The explicit **Check saved request** action calls the canonical SDK reconciliation
endpoint with the original in-memory command key, input, expected version and
idempotency key. It never re-executes the write. A missing/unreadable receipt keeps
the write uncertain and prevents another mutation. Re-sign-in preserves that
pending request within the same configured application; changing configuration
cannot silently discard the held outcome. Only a current matching admitted
committed receipt unlocks subsequent writes. No request is saved in browser storage.


The reference source supports an explicit `dispatchCommands: true` deployment
option. Its signed MCP `dispatchRecord` takes `{ type, id, fields,
expectedVersion, expectedPolicyVersion, destination: "source_outbox",
idempotencyKey }`. It checks current source read/mutate rights and exact signed
command intent, then atomically stores selected values in its own durable
`dispatches` outbox plus a receipt in `effects`. It leaves parent record versions
unchanged because dispatch is a separate child operation. Brian receives only
state/receipt/digest and keeps its full original ancestry. Replay and
reconciliation do not enqueue again; current source revocation still applies.
The dispatch profile advertises `command_v1`, serves native setup reads at
`/http/read`, and refuses the legacy `/records/command` endpoint. Record-changing effects require the source's own exact historical authorization.
The same profile exposes signed MCP `updateRecord` with
`{ type, id, expectedVersion, expectedPolicyVersion, values, idempotencyKey }`.
It reuses the canonical source mutation, stores an immutable before-image and
receipt atomically, and reconciles under the original actor/assistant/digest
without dispatching again. The reference source explicitly permits governed
historical read/context/derive/retain under current source rights and unchanged
policy. Missing history, withdrawal, policy drift or field/action contraction
refuses. Brian keeps its original observation IDs and versions. A source without
these independent historical rights retains the held uncertain/no-retry result.
