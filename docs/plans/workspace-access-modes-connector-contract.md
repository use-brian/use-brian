# M0 connector setup and Simple provider exposure contract

Status: proposed implementation contract, not shipped behavior or a KB plan. Companion to `workspace-access-modes-and-migration.md` §§4.2, 8, AM12–AM13. Scope is connectors only; workspace policy schema, general resource admission and nonconnector manifests remain owned by their respective workstreams.

## 1. Findings and minimum safe decision

- `packages/api/src/db/connector-instance-store.ts`: `createWorkspaceInstance` defaults omitted compartments/Projects to `[]`; `createUserInstance` relies on database defaults. `connected`/health are not setup authorization. `getAuthCredentials{System}` deliberately reads disconnected rows for probes.
- `packages/api/src/db/connector-grant-store.ts`: `create` defaults both arrays to `[]`; conflict returns the existing grant without checking requested binding. Grant creation and subsequent sensitivity update are separate operations in `routes/connector-instances.ts`. Revocation and stopping ingestion are also separate statements.
- `packages/api/src/db/connector-store.ts` is a compatibility projection over **connector_instance**, despite older dual-store comments. Its `upsert`/`setConnected` target the oldest personal provider instance; it is another writer, not a harmless legacy table.
- `connectors/lifecycle-service.ts` centralizes some mutations, but direct route, agent and SQL writers remain. `attachCredentials` immediately connects; reconnect can replace the account behind existing shares. Transfer clears grants/routing atomically but does not resolve a new context.
- `context-scope/connector-exposure.ts::connectorExposureAllowed` interprets empty arrays as unbounded. Generic catalogs require universe read, mutation and Project authority even if labelled with one department. Its non-agent administrative no-scope branch is not an authorization service. Only audited callers select `fixed-operation`.
- Web OAuth state has cookie-nonce CSRF protection, provider/workspace/instance intent and optional chat continuation, but no server-owned admission or account-sharing consent. UI auto-exposure occurs **after** connect. Single-account fallback still cannot establish consent.

Decision: one canonical server-owned pending setup and transactional activation for every material connector mutation. Add a separate, exact-instance/grant, revocable **Simple provider exposure approval**. Never change `ScopeGrant`, membership, RLS, read-all, Project semantics, or the meaning of empty arrays to make catalogs work. Unsupported providers/operations remain denied. Existing rows receive no automatic approval.

## 2. Canonical pending setup

Proposed homes: `packages/api/src/connectors/setup-service.ts`, `packages/api/src/db/connector-setup-store.ts`, and `packages/api/src/routes/connector-setups.ts`. Names are proposed, not existing APIs. Extend the existing lifecycle service as the only application mutation facade; stores accept a transaction-scoped admitted command, not optional scope arrays from arbitrary callers.

### Durable contract (logical fields; schema workstream owns DDL)

- Random setup ID; initiating authenticated human/principal and surface; workspace (or explicit personal-only intent); provider; immutable intent `create | reconnect | share | transfer | rebind`; requested ownership and credential owner.
- Exact target instance/grant IDs and expected versions for existing objects; create-new is distinct from reconnect. Never resolve a reconnect by provider/oldest account at finalization.
- Admitted department/Project envelope, binding intent/origin, sensitivity floor, import destination and opt-in ingestion intent. Preserve omitted versus explicitly selected General; no `[]` default as admission.
- Workspace access-policy revision; authority snapshot references; provider boundary proposal; expiry; hashed one-use nonce; OAuth session/PKCE binding where supported; allowed callback/redirect identity; optional exact session/approval continuation.
- Encrypted staged credential reference, verified provider identity/root evidence and consent digest; no tokens, CLI environment secrets, document bodies or raw provider errors in review/audit payloads.
- Status/version and idempotency key: `pending_auth -> pending_review -> ready -> active`, with `stale`, `failed`, `cancelled`, `expired` terminal/nonusable outcomes. Persist activation result IDs so retries return the same result.

Pending credentials live outside active instance credentials. Setup status is independent of connected/health. Only a narrowly authorized setup probe can read staged credentials; ordinary lists, tool discovery, legacy projections, credential access, ingestion and webhook fan-out cannot see/use them. Owner setup-management views may show redacted pending metadata.

### Protocol

1. **Start:** authenticate and resolve live ownership/membership/mutation authority; call canonical resource admission. Simple prefills the default department only for ordinary shared intent, never for personal-only intent. Preserve inherited Project/private/sensitivity floors. Departments requires an authorized destination or leaves setup pending. Capture versions and explicit sharing intent before external work.
2. **Authenticate/probe:** OAuth state carries only an opaque integrity-protected setup reference plus CSRF correlation, validated server-side against actor/workspace/provider/session/redirect. Maintain browser cookie and desktop loopback protections; support independent per-setup nonces for concurrent tabs. Exchange/consume code once; store the encrypted result durably before resuming review. Manual, API-key, CLI and custom MCP probes enter the same state machine. A successful probe is not sharing approval.
3. **Review actual account:** resolve stable provider subject/tenant/root from authenticated provider evidence, not client email/label. Present verified account, roots, recipient workspace/audience, operation set, import destination and personal-data risk. Consent after authentication is required when the account was previously unknown or differs from the approved identity.
4. **Activate:** lock/CAS setup, workspace policy revision, target instance/grants and relevant authorization records in one database transaction. Recheck actor, owner, membership, clearance, admission, account consent digest and target versions. Commit credentials, instance ownership/context, exact grant, optional exposure approval, ingest admission/routing and durable audit/outbox together. External exchanges are outside this transaction; enqueue pollers/resume only after commit. Concurrent revoke/removal/rebind must serialize against activation.
5. **Failure/resume:** stale revision yields `stale`/review-required, not automatic approval of a newly computed scope. Validation errors leave no newly usable exposure. Cancel/expire erase only setup-owned staged material; provider revocation is permitted only when known not to invalidate any pre-existing credential. Reconnect failure leaves the previous admitted instance unchanged (possibly already unhealthy), not disconnected/re-scoped by cleanup.

Same-account reconnect preserves ownership, sensitivity, context, grants and import routing; compare their versions at activation. It may retain consent only when identity, roots, permissions and policy revision are unchanged. Changed account/root/endpoint/auth reach is a new review, never an in-place silent credential swap. If one personal instance has grants into multiple workspaces, a material account change requires renewed approval for every retained exposure; otherwise suspend those exposures atomically. Never reset arrays, recreate revoked grants or resurrect a cancelled setup. Cosmetic renames need not require consent.

Old clients: reject material writes lacking setup/admission with a stable `connector_setup_required` response and continuation URL; allow only explicitly safe personal draft installation without activation. Do not silently share, pick an oldest account, or accept a connected flag as finalization. Setup creation by an API/MCP principal does not authorize interactive-human approval impersonation.

## 3. Account consent and approved Simple exposure

Proposed home: `packages/api/src/context-scope/connector-provider-exposure.ts`, backed by a dedicated approval store (not client-controlled instance config).

Approval binds workspace + exact instance + exact grant ID/version (or workspace ownership version), policy revision, credential **identity generation**, verified provider subject/tenant, canonical roots, adapter/version, allowlisted operations, sensitivity/import envelope, audience eligibility rule, credential-owner consent, workspace owner/admin approval, timestamp and revocation state. A sole owner can provide both consents in one review. Sharing an existing personal instance requires its owner's consent; admin status cannot substitute for control of that account. Ordinary member sharing does not automatically qualify for the Simple catalog exception.

Use a digest over that canonical tuple for review/commit comparison. Email, connector label, an OAuth app registration, account login, a tool's claimed read-only annotation, or possession of a PAT alone is not evidence of consent to workspace-wide provider reach. Refresh-token rotation can preserve identity generation only through an audited adapter proving unchanged identity/permissions; arbitrary credential replacement cannot.

Provider boundary options:

| Boundary | Minimum proof / fallback |
| --- | --- |
| Dedicated whole account/tenant | Verified stable identity and explicit approval of all data reachable by the allowed operations, including future data within that boundary. Mixed personal/company accounts remain personal or unavailable. |
| Provider-native root | Adapter enforces canonical roots on list/search/read/write, pagination, redirects, indirect IDs and downloaded content; rejects escape before returning metadata. Labels or post-fetch model filtering do not qualify. |
| Generic/custom MCP or CLI | URL, executable path, cwd and tool descriptions do not prove data isolation. No Simple catalog exception without audited identity/root and operation adapter. Keep personal or preserve existing restricted-context denial. |
| Fixed native operation | Keep existing code-selected exception and its scope/action checks; do not let registry/client/tool metadata select it. |

No provider is certified by this document. Whole-account support still needs an audited adapter; Drive picker/catalog scope, mailbox names, Shopify shop domain, GitHub repository settings and storage prefixes are evidence candidates, not blanket certification.

### Runtime derivation, not a bearer permission

Keep the existing exposure gate unchanged for its existing use cases. A new trusted resolver may authorize a particular catalog operation only after all of these checks:

1. Live workspace is Simple at the approved revision; approval and exact instance/exposure are active and unchanged; credential identity/boundary match.
2. Actual executing caller is a current eligible internal member, with normal connector rights, sensitivity clearance and assistant capability/action permissions. Do not substitute grantor, assistant owner or billing owner for the human.
3. Trusted turn provenance says ordinary default-shared workspace context, with default-department mutation authority and no narrower direct/delegated/session/recipient ceiling. A finite set equal to the default department alone is **not** proof: explicit department-restricted turns must remain denied. Missing provenance denies.
4. No Project-restricted context in the minimum implementation. A later audited native-root adapter may support one only by proving and enforcing that Project boundary. No guest/public/API-key/MCP-programmatic/channel-audience or unattended-job exception in M0; those need separate reviewed execution authority, not inherited interactive approval.
5. Exact operation is allowed by the adapter and existing Allow/Ask/Block, write/destructive grants and delivery checks. Approval never grants new action authority or bypasses external-send confirmation.

Return an internal operation-bound decision, not a new scope universe or serializable token that tools can replay. Apply it before catalog discovery and again at credential acquisition/provider invocation and before result release. Cover all injection lanes and direct/fixed-provider entry points; no fallback to an unapproved sibling/oldest account after denial. Provider output imports still pass normal content admission and retain source floors/lineage; this permission cannot read private Brian rows or credentials, lower classification, or create new content rights.

### Invalidation and in-flight work

Use the policy workstream's monotonic access-policy revision, not a second connector-specific mode flag. Every access-policy revision change invalidates pending admission and Simple approvals conservatively, including switching away and back. Reapproval is explicit; do not copy a revision forward.

Also invalidate on grant revoke/recreate, ownership/scope/sensitivity/root/endpoint change, credential identity change, disconnect/delete, or applicable membership/assistant rights loss. Membership eligibility is checked live; removed-and-readded actors must not revive an old run. Connector-local versions cover changes not represented by workspace policy revision.

Compose connector checks with `context-scope/authority-lease.ts`; scope containment alone cannot detect a Simple approval revision change. Pin revision/approval/identity versions for a run, permanently fail its lease on mismatch, evict discovery/credential caches, cancel queued work and recheck already-running work before returning output. A remote side effect cannot be rolled back: report uncertain outcome and never blindly retry. Transactional revocation must stop ingest routing/outbox admission; already imported content is not deleted or relabelled implicitly.

## 4. Connector adapter manifest / exact touchpoints

Paths below are relative to the repository; API paths abbreviated with `packages/api/src/`, web paths with `apps/app-web/src/`. Every row is required coverage, not a claim of current compliance.

| Adapter / entry path | Existing touchpoints | Required integration |
| --- | --- | --- |
| Shared lifecycle/storage | API `connectors/lifecycle-service.ts::{install,attachCredentials,connect,update,transferToWorkspace,configure,rename}`; `db/connector-instance-store.ts`; `db/connector-grant-store.ts`; `db/connector-store.ts::{upsert,setConnected,setConfig}` | Route all material activation/replacement/rebinding through setup; transaction-aware store writes, explicit admission, exact IDs, versioned invalidation. Legacy projection cannot bypass pending. |
| OAuth/manual provider credentials | API `routes/connectors.ts::persistConnectorInstance`; `/:provider/store-credentials`, `/:provider/exchange-and-store`, `/gdrive/oauth-callback`, `/msgraph/oauth-callback`, `/shopify/oauth-callback`, `/shopify/app-credentials`; `connectors/{desktop-oauth-exchange,app-credentials}.ts` | Stage provider results; verify actual subject/root/scopes; distinguish app registration from account consent; bind redirects and exact target. Include generic PAT and provider verification branches (WordPress/GSC/Shopify). |
| Browser OAuth/setup | Web `lib/{connector-oauth-state,connector-oauth-desktop,oauth-state-cookie,connector-authorization-completion,msgraph-oauth}.ts`; `app/api/auth/callback/{google-connector,notion,fathom,shopify,msgraph}/route.ts` | Server setup reference across all exchanges; no permission fields trusted from state/body; callback returns pending review or finalization receipt, never auto-share evidence. |
| Desktop OAuth | `apps/app-desktop/src/desktop-connector-oauth.ts`; API `connectors/desktop-oauth-exchange.ts` and exchange-and-store route | Bind API-authenticated initiator, nonce, loopback/redirect and setup; stage result exactly like web. Retain nonce protections and add PKCE where supported; no browser-cookie dependency for desktop. |
| Frontend connect/share/reconnect | Web `app/w/[workspaceId]/studio/connectors/{page,browse-directory}.tsx`, `lib/connector-auto-expose.ts`, `components/context/connector-context-binding.tsx` | Replace post-connect auto-grant effect with server receipt/status. Review actual account; preserve personal intent. Context editing is reviewed rebind, not a second-step repair for unbounded creation. |
| Sharing/transfer/admin reconnect | API `routes/connector-instances.ts::{memberConnectorInstanceRoutes,workspaceConnectorInstanceRoutes}` (`/grants`, `/transfer`, `/credentials`, PATCH); `routes/context-scopes.ts` connector context GET/PUT | Atomic context + sensitivity + grant activation; dual consent for Simple exception; exact grant/instance validation on revoke. No clearance-only credential replacement broadening. |
| Brian / MCP configuration tools and chat continuation | API `agent-surface/write-tools.ts::{addPatConnector,requestConnectorAuthorization}`; `routes/sessions-questions.ts` connector authorization completion; `routes/assistant-mcp.ts` | PAT tool must stage, not create+share immediately; human review binds setup/instance/account/session/approval. Completion must verify activation receipt, not merely connected/provider; resume via idempotent outbox. MCP configuration capability is not catalog exposure approval. |
| CLI and remote/custom MCP | API `routes/connectors.ts` `/cli/connect`, PATCH `/cli/:id`, directory add, instance/provider connect; `routes/custom-connectors.ts` POST/PATCH/test; `mcp/{cli-transport,client}.ts` | Probes restricted to setup, secret-safe diagnostics; env/binary/args/cwd/URL/auth changes invalidate boundary. Probe cannot activate grants. No unsupported catalog bypass. |
| Storage and mailbox/native routes | API `routes/connectors.ts` GCS/S3/local connect/import, IMAP connect/backfill, Drive catalog-scope/enrichment-import; `routes/ingest.ts` | Direct workspace writers also need admission; reconnect preserves binding. Import/backfill/ingestion-enable is a separate authorized destination decision, not implied by provider sharing. |
| Channel-provisioned metadata instances | API `ingest/channel-connector-instance.ts::ensureChannelConnectorInstance` (Slack/WhatsApp/Feishu); `ingest/msteams-connector-instance.ts::ensureMsTeamsConnectorInstance` | Replace direct inserts with internal admitted finalizer; transactionally bind integration/instance/rules. Channel credential remains in its own store; channel audience never becomes Simple member authority. Nonconnector channel admission is a dependency, not redesigned here. |
| Archive metadata writer | API `chat-archive/live-writer.ts` direct connector insert and cached binding resolution | Internal admitted metadata-only instance; no provider approval inferred. Recheck destination/revision when using cached bindings; coordinate with intake owner. |
| Discovery/use/revocation consumers | API `mcp/inject.ts::injectMcpTools` personal/grant/workspace/custom/CLI lanes; `connectors/usable-connectors.ts`; system readers in both connector stores; `structured-documents/connector.ts`; `crm-operations/delivery-native-authority.ts` | Exact exposure authorization before discovery and call, live invalidation, no sibling fallbacks. Preserve audited fixed operations. Filter pending from system workers/credential lookup/event fan-out, not only UI. |

Hosted/closed route implementations are outside this checkout's inspected source. Shared open factories are necessary but not proof of hosted coverage: require hosted callers/writers to use the same finalizer and execute parity assertions before release. Audit future writers with searches for `createUserInstance`, `createWorkspaceInstance`, grant `.create`, legacy `.upsert`, direct `INSERT INTO connector_instance/connector_grant`, credentials/connected/config updates. Any unmatched writer blocks certification.

## 5. Required test assertions and release evidence

Extend existing API suites under `connectors/__tests__/{lifecycle-service,usable-connectors}.test.ts`, `context-scope/__tests__/connector-exposure.test.ts`, `db/__tests__/connector-grant-store.test.ts`, `mcp/__tests__/inject.test.ts`; route suites `connector-instances`, `custom-connectors`, `connectors`, `connectors-cli`, `connectors-imap`, provider-specific connector suites, `context-scopes`, `ingest`, `sessions-connector-authorization`; agent `connector-authorization` and channel-instance tests. Extend web `connector-oauth-state`, `connector-oauth-desktop`, `connector-auto-expose`, context-binding and browse-directory suites; add canonical setup transaction/concurrency and provider-adapter contract suites.

| Assertion | Expected proof |
| --- | --- |
| Every manifest entry, both modes, old clients | No active grant/instance/ingest admission between credential storage and finalization; pending unavailable through UI, legacy, system, discovery and credential readers. Missing selection cannot become `[]`. |
| OAuth/manual security | Wrong actor/workspace/provider/session/instance, expired/replayed nonce, altered redirect, callback without browser/desktop correlation denied. Concurrent tabs independent; callback retry creates exactly one result; tokens and provider bodies absent from logs/audit. |
| Transaction failure injection | Fail after each proposed write: no partial exposure/routing/consent. Retry/outbox resume exactly once. Revoke, membership removal, transfer and policy update racing activation cannot commit stale admission. |
| Reconnect | Same identity retains exact scopes/ownership; different account/root waits for consent across all target workspaces. Failed/cancelled reconnect preserves old credentials/grants; cleanup never revokes a shared token. Old provider-primary and custom PATCH/connect routes cannot evade this. |
| Consent | Forged email, ungranted sibling account, new OAuth scope, changed root, MCP metadata and CLI cwd cannot qualify. Owner+admin approvals bind identical digest; sole owner can approve once. Personal account never becomes shared because workspace is Simple. |
| Positive Simple case | Audited dedicated-account/root fixture, approved exact grant, eligible ordinary shared human turn: permitted catalog operation works despite finite default department, while scope grants remain unchanged. |
| Negative authority matrix | Same approval fails in Departments, explicit department/Project context, read-only/direct/delegated narrower ceiling, guest/public/API/MCP/job/channel execution, missing trusted provenance, insufficient clearance/action policy or different instance/grant. Existing fixed-operation tests remain unchanged. |
| Revocation and policy revisions | Switch Simple→Departments→Simple, revoke/recreate grant, membership removal/readd, credential replacement and root change invalidate cached tools, running leases, queued jobs and result release. No old run resurrects after reapproval. |
| Content isolation | Private Brian rows/files/credentials remain inaccessible; import destination keeps Project/sensitivity/source floors. No read-all, membership/package mutation, automatic historical relabel, extra write permission or external delivery bypass. |
| Provider boundary | Cross-root IDs/search/list/pagination/redirect escapes denied, including metadata; unknown operations unavailable. Provider-native isolation requires executable adapter tests, not connector labels. |

M0 outcome: this freezes the minimum contract and known writer/consumer coverage. Implementation, transactional integration tests, hosted parity and per-provider security certification remain release blockers. Until those pass, preserve current finite-context catalog denials and advertise only the supported connector subset.
