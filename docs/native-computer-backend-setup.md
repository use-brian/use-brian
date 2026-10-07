# Native computer: non-production backend readiness

Readiness is a read-only setup check, not Mac acceptance or a deployment command. Use the **modified API/relay from this feature branch** in an authorized non-production environment, including an isolated local stack. The user explicitly authorized spawning that stack in the sandbox; an existing external deployment is not required. Normal local-owner onboarding and generation of this new local installation's secrets are legitimate setup, not fabricated credentials. Never mint test JWTs, use dev-login, fabricate native grants, change production or enable acceptance flags to obtain a passing report.

## Verified local sandbox setup

The modified stack was actually started with a fresh PostgreSQL **18.6** database and pgvector/pg_trgm, applying the normal OSS migrations through 621. A separate non-owner `NOSUPERUSER NOBYPASSRLS` application role supplies `DATABASE_URL_APP`; `PG_SINGLE_CONNECTION` is unset. Use real PostgreSQL for this verification: the embedded single-connection path currently shares the system pool and does not establish user-role RLS enforcement.

Running sandbox endpoints (loopback only, not public deployment URLs):

| Component | Address |
| --- | --- |
| Web | `http://127.0.0.1:43003` |
| Modified API | `http://127.0.0.1:44000` |
| Modified browser/native relay | `http://127.0.0.1:48094` |
| Doc-sync | `ws://127.0.0.1:48080` |
| Isolated PostgreSQL | `127.0.0.1:55439`, database `native_sandbox` |

The private local state directory is recorded in `/tmp/native-stack-path`; it contains owner-only environment/session files, logs and process IDs. Do not print or commit those files. Data is not automatically deleted. These processes are session-lifetime resources, not hosted infrastructure; verify listeners before reuse. API starts with its existing `--no-workers` option to avoid unrelated background automation; the native HTTP task runtime remains mounted. Channel bridges were not started because they are unrelated to this loop and need their own credentials.

The normal `/auth/local-session` flow created the local owner and workspace. Normal assistant, conversation and capability routes provisioned context, and the new explicit **Create task** action successfully created and selected a genuine owned task in a real Chromium browser. No direct identity/task row insertion, forged JWT or native grant was used. An ordinary personal chat creates a personal conversation; `/api/sessions/workspace` creates a shared room and is **not** a substitute for the personal-conversation picker.

Use the existing package entrypoints, not a separate native execution harness. For isolated launches, supply protected environment values before running:

```sh
# Migrate ONLY after verifying the newly created isolated database destination.
# MIGRATION_DIRS must be empty for the OSS schema.
MIGRATION_DIRS= pnpm --filter @use-brian/api migrate
# Build dependencies and entrypoints using the commands below.
API_HOST=127.0.0.1 PORT=44000 node apps/api/dist/index.js --no-workers
HOST=127.0.0.1 PORT=48094 pnpm --filter @use-brian/browser-relay start
HOST=127.0.0.1 PORT=48080 pnpm --filter @use-brian/doc-sync exec tsx src/index.ts
pnpm --filter app-web exec next dev --hostname 127.0.0.1 --port 43003
```

Set `USEBRIAN_EDITION=oss`, `USEBRIAN_SINGLE_PROCESS=1`, the two database URLs, local JWT/relay/doc-sync/encryption secrets, a deployment ID and consistent API/APP/relay/doc-sync URLs; set `NATIVE_COMPUTER_ENABLED=true` for the relay. Web uses `API_INTERNAL_URL`, `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_USEBRIAN_EDITION=oss`. Configure no provider credentials unless legitimately supplied. API's `API_HOST` and doc-sync's `HOST` are optional explicit bind addresses; absent values preserve existing behavior. Do not expose OSS local-owner onboarding on an unauthenticated public interface. A Mac can later use protected port forwarding; sandbox localhost is not Mac localhost.

**Actual backend-only report:** `ready:false`, blockers `model_unavailable`, `device_not_checked`. Schema/auth/scope/policy/conversation/accounting-capability/relay checks passed. No model credential or custom endpoint is configured in this fresh installation. Provider setup—not another backend deployment—is the remaining inference prerequisite. No provider was substituted, inference performed, native session/grant created or accounting receipt fabricated.

## Existing setup

Run the feature revision with one API instance (or the existing required sticky routing) and one relay. In the operator's existing protected environment:

```sh
pnpm --filter "@use-brian/api-open^..." run build
pnpm --filter @use-brian/api-open build
pnpm --filter @use-brian/browser-relay build
# Separate terminals/processes with their existing deployment environment:
pnpm --filter @use-brian/api-open start
pnpm --filter @use-brian/browser-relay start
```

API: nonempty `NATIVE_COMPUTER_DEPLOYMENT_ID`, stable existing `JWT_SECRET`, `BROWSER_RELAY_SECRET`, `BROWSER_RELAY_URL`, and normal database/auth/provider settings. The API initializes native service from those settings without a feature flag. Relay: `NATIVE_COMPUTER_ENABLED=true`, matching existing JWT/relay secrets and explicit `HOST`/`PORT`. Direct entrypoints need their environment supplied; do not assume the root `.env` is loaded identically by every package.

Set `BROWSER_RELAY_URL` to the relay's **HTTPS** base (HTTP only for permitted loopback), not a `wss:` URL: API readiness/commands use HTTP fetch. Session exchange converts that same base to the desktop's WebSocket URL. It must be reachable by both API and Mac, using HTTPS/WSS except loopback development. Linux localhost is not Mac localhost. Reverse proxies must preserve the native HTTP and `/native-computer-v1` upgrade paths. Readiness cannot prove topology/affinity or WebSocket/JWT compatibility.

The normal database must already have migrations `620_native_computer_sessions.sql` and `621_native_usage_receipts.sql`. `pnpm --filter @use-brian/api migrate` is the existing **writing** migration command: it is never run by readiness. Separately confirm the non-production database destination before any migration.

`pnpm dev`/`pnpm start` use the local-owner launcher: they may prompt, generate/persist secrets, start sidecars and create local-owner state. They are not a transparent launcher for an existing authenticated deployment. `USEBRIAN_CORE_ONLY=1` skips its local relay. A cloud login does not create an account in an independent local database. ChatGPT/Codex onboarding alone does not supply a native-strict supported model route.

## Run the checker

Use context IDs from the deployment's normal owned workspace/assistant/conversation/current task; do not invent rows or reuse IDs from another deployment. The normal This computer **Create task** action now creates the required owned assistant-bound task after assistant/personal-conversation selection, including from the web setup page. The intended desktop's existing native `status` response includes `deviceId`. The same UUID is stored in `native-computer-device-id` under that app's Electron `userData` directory; read it without modifying it if needed. Do not generate a substitute device ID: that would miss the actual device's unknown/busy fence.

Use a currently valid access token from the deployment's ordinary authenticated session. Supply it through an existing owner-only regular file (mode 0600 or stricter, no symlinks), or noninteractive stdin. Do not place tokens in command arguments, shell history or reports. The checker never prints token contents, URLs, raw errors or response bodies.

```sh
pnpm native:readiness --non-production \
  --api https://api.your-test-deployment.example \
  --token-file /private/path/existing-access-token \
  --workspace-id "$WORKSPACE_ID" --assistant-id "$ASSISTANT_ID" \
  --conversation-id "$CONVERSATION_ID" --task-id "$TASK_ID" \
  --device-id "$DEVICE_ID"
```

For off-Mac backend checks, replace `--device-id "$DEVICE_ID"` with **`--backend-only`**. This explicitly omits device identity, still checks all feasible backend predicates, and always returns `ready:false` / exit 1 with `device_not_checked`. It cannot certify the intended Mac's busy/unknown fence. The modes are mutually exclusive; never generate a substitute device ID. Other blockers such as `model_unavailable` remain visible.

`--token-file -` reads stdin instead, with an 8 KiB cap and five-second input timeout. Use your existing credential manager to supply stdin; do not echo a literal token. `--api` is the API origin, not an `/api` path. HTTPS is mandatory except HTTP localhost/127.0.0.1/[::1]. Credentials, query strings, fragments and redirects are rejected. `--non-production` is the operator's explicit destination acknowledgement, **not automatic proof of deployment classification**.

The CLI sends exactly one authenticated `POST /api/native-computer/readiness`, containing the five context fields above, or the four scope fields plus `backendOnly:true`. POST keeps identifiers out of query-string access logs; this endpoint performs no data writes. The API uses authenticated user/session identity, not client user IDs. It checks migration/schema availability, auth-session liveness, existing membership/capability/task predicates, existing tool-policy blocks, device busy/unknown fences, the same-user/conversation lease across all devices/deployments, and relay readiness. It never expires sessions, constructs grants, clears unknown state, performs accounting admission/reservation/reconciliation, calls a model or dispatches commands.

The API response deadline is eight seconds; relay fetch is five seconds and capped at 1 KiB. The CLI request is capped at ten seconds and its response at 8 KiB. A response deadline does not cancel an already-running SELECT: the normal database statement timeout still applies. Readiness is a point-in-time preflight, not an authorization lease or an atomic multi-query snapshot; normal dispatch revalidation remains authoritative.

Output is a bounded protocol/ready/blockers/warnings JSON object. Exit 0 means the configured checks passed; exit 1 means a blocker or failed check. No retries. `ready` describes **configuration preflight only**, never live model success or native execution.

| Blocker | Operator action |
| --- | --- |
| `native_disabled`, `configuration_invalid` | Verify intended API revision and native/relay settings; do not alter production. |
| `schema_unavailable` | Inspect the selected test database/migration state separately. No automatic migration. |
| `auth_session_denied`, `scope_denied` | Use normal login and owned workspace/assistant/conversation/current task with active native capability. |
| `policy_denied` | Review existing native tool policy through normal administration. Checker never changes it. |
| `device_not_checked` | Expected in backend-only mode. Obtain the actual desktop ID for full readiness later; no device check was skipped silently. |
| `device_busy` | Device or conversation already leased. The conversation check matches the partial unique index (`user_id`, `conversation_id`, `revoked_at IS NULL`), including expired but not-yet-revoked rows. Readiness does not run expiry cleanup. Stop/reconcile through the existing deliberate workflow. Never clear unknown effects or replay automatically. |
| `relay_unavailable`, `relay_disabled` | Check revision, native enablement, HTTPS routing and existing shared secret. |
| `accounting_unavailable` | Use a supported registered native accounting backend; generic usage-store presence is insufficient. |
| `runtime_not_checked` | The model check is missing or an opaque host runtime override cannot be inspected; not a passing configuration. |
| `model_unavailable`, `provider_unsupported`, `credits_blocked`, `budget_invalid` | Inspect the existing configured route/policy/credits/bounds without model substitution or raising budgets. |
| `check_failed` | Inspect bounded local diagnostics; do not upload environment files or raw provider logs. |

Warnings always distinguish unverified JWT compatibility, live model behavior and Mac verification. Image-related warnings are evaluated from the **same resolved task route and effective budget** as production runtime, without uploading an image:

- `vision_image_unsupported`: the configured route lacks supported image capability (including native custom-endpoint image restrictions). No alternate provider is selected.
- `vision_approval_unaccepted`: explicit image approval is disabled or the exact configured-model approval pin is missing.
- `vision_approval_mismatch`: the approval pin differs from the resolved task model. The pin never selects a different image model.
- `vision_budget_insufficient`: the effective token/cost bounds cannot accommodate even one conservative image reservation. Applies to insufficient overrides as well as defaults. A fitting reservation does not guarantee a whole task fits; no budgets are changed or reserved.
- `vision_not_checked`: model inspection was skipped, unavailable, or failed; absence of the other warnings is not approval.
- `native_strict_adapter_unverified`: the provider interface has no affirmative native-strict capability contract. Registration alone cannot establish that support. Known Codex routes are additionally blocked as `provider_unsupported`, because their adapter explicitly refuses native-strict inference.

`ready` can be true for AX/text configuration despite image warnings; it never means image execution or any Mac capability is accepted. The report contains no model IDs, provider URLs, grants or credentials. Warning arrays are bounded to **8**, with only the fixed codes above and the three always-present verification warnings. The old `vision_default_budget_insufficient` warning is replaced by `vision_budget_insufficient`.

## Native task picker

`GET /api/native-computer/context-tasks` accepts only UUID `workspaceId`, `assistantId`, `conversationId` query fields under normal session-backed authentication. It returns at most 500 `id/title` rows (titles capped at 256 characters), with `Cache-Control: no-store`. It intersects the native owned conversation/assistant/task, membership, native capability and current-task predicates with the established workspace viewpoint/task-read access predicate and user-scoped RLS. Clearance or compartment reduction must not disclose previously accessible task titles. This is discovery metadata, never a grant; create/run/dispatch still revalidate independently. The ordinary server routing/logging policy applies to context IDs in the URL; credentials and task content are never query fields.

`POST /api/native-computer/context-tasks` uses normal touching/session-backed auth and strict `{ workspaceId, assistantId, conversationId, title }`. It validates the exact owned conversation/native capability and established task mutation/read scope, then uses the ordinary task store to create an internal user-owned, assistant-bound task. It grants no computer authority. Trusted store construction suppresses creation triage, workflow dispatch and waiting-goal resumption for this explicit setup action while retaining normal cache notifications; ordinary task creation automation is unchanged. No untrusted task field can select this suppression.

The app loads this list only after assistant/conversation selection, keys it by viewer and context, clears selection on context changes, ignores late replies from other contexts, and offers explicit retry on load failure. An empty list is not permission to invent a task ID: use a normally owned current task for the selected assistant with appropriate read access. The explicit Create task UI re-reads through the permission-filtered list before selecting the new task, invalidating any pending pre-create read first. Context changes fence stale prompts/results. No setup credential or task is fabricated by the read route.

## Existing vision approval and budget controls

These are trusted API deployment settings, not model/user grants. Readiness only reports them. Do **not** automatically enable approval, change the configured model, or raise budgets to clear a warning; review the exact non-production route, data destination and worst-case bounds first. Approval never enables Mac input or replaces local capture consent/permissions and platform acceptance.

| API environment setting | Existing behavior/default |
| --- | --- |
| `NATIVE_COMPUTER_VISION_ACCEPTED` | Approval is off unless exactly `true`; setting it is an explicit reviewed approval, not setup automation. |
| `NATIVE_COMPUTER_VISION_MODEL` | Exact approval pin for the resolved configured task model; unset by default. It does not select/substitute an image provider/model. Mismatch or absent pin refuses image approval. |
| `NATIVE_COMPUTER_TOKEN_BUDGET` | Default **262144** non-refundable per-grant conservative token units. |
| `NATIVE_COMPUTER_COST_BUDGET_USD` | Default **26.2144** per-grant conservative USD bound. |
| `NATIVE_COMPUTER_ATTEMPT_COST_USD` | Default **3.2768** per 32768 attempt units; attempt token bound is fixed at **32768** in this boot path, not a separate environment control. |

Runtime reserves at least 32768 units for a text attempt. An image attempt conservatively reserves `max(attemptTokens, 4 * 1024 * 1024 + 32768)` = **4227072 units** with defaults, and `attemptCostUsd * (units / attemptTokens)` = **$422.7072**. The default rate is **$100 per million units**; these are conservative reservation bounds, not a provider invoice or an estimate of typical screenshot token usage. Multiple attempts and prior task work consume additional non-refundable grant budget. The default 262144 / $26.2144 text budget cannot fund even one such image reservation. Increasing bounds is neither sufficient acceptance nor an instruction from this runbook. Readiness performs no reservation, inference or accounting write.

## Production boot integration

Production boot supplies the third parameter to `nativeComputerRoutes(service, tool, readinessOptions)` and now mounts `nativeComputerAuth` instead of the outer native `requireAuth`:

```ts
app.use('/api/native-computer', nativeComputerAuth(env.JWT_SECRET),
  nativeComputerRoutes(nativeComputerService, allTools.get('nativeComputerTask'), nativeComputerReadiness))
```

Do not leave an outer `requireAuth` before this helper: ordinary auth updates `last_seen_at` for sessions older than five minutes. `nativeComputerAuth` selects `requireAuthWithoutTouch` for the readiness POST and context-tasks GET (including normal Express case/trailing-slash variants). Other native routes retain ordinary touching authentication. Both use exactly the same JWT signature/kind/expiry, UUID, user auth-version and session owner/revocation/expiry admission; only the optional activity UPDATE is suppressed. Request headers/body/query cannot opt other routes out of touching. The readiness route still independently requires a session-backed identity. No auth bypass or refresh/session creation is introduced.

The model readiness wiring uses `createNativeComputerReadinessOptions(nativeAccounting, nativeModelOptions, runtimeOverridden)`:

- Accounting availability comes from the actual registered/explicit native accounting capability, **not** merely a usage store. Readiness invokes no accounting methods.
- `nativeModelOptions` is the same object passed to the native runtime factory: provider, workspace resolver, plan/credit readers, decision-route resolver, effective budget and exact image approval settings.
- `checkModel(scope)` returns bounded `{ blockers, warnings }` metadata after the existing auth/scope/service checks. It calls `inspectNativeComputerModelReadiness` once using the workspace ID; it never creates a runtime, fake ToolContext, grant, session or provider invocation.
- An opaque host runtime override reports `runtime_not_checked` rather than inheriting claims about the default runtime. Missing accounting prevents model inspection. Resolver exceptions become `check_failed` without exposing raw errors.

The shared-secret-protected relay `GET /internal/native-computer/readiness` is already wired before the native-disabled guard and returns **only** `{ enabled, protocol }`, even when disabled. It never asserts JWT compatibility.

## Local verification (synthetic only)

```sh
node --test scripts/__tests__/native-computer-readiness.test.mjs
pnpm --filter @use-brian/api exec vitest run src/db/__tests__/auth-session-store.test.ts src/auth/__tests__/middleware.test.ts src/computer-use/readiness.test.ts src/routes/__tests__/native-computer.test.ts src/computer-use/__tests__/service.test.ts --maxWorkers=1
pnpm --filter @use-brian/browser-relay exec vitest run src/native-readiness.test.ts
pnpm --filter @use-brian/api typecheck
pnpm --filter @use-brian/browser-relay typecheck
```

These tests use synthetic credentials and mocked database/HTTP dependencies (route tests use local test servers). They are not authenticated deployment, provider, signed-package, Mac SDK or real native behavior evidence. All source/setup work belongs here; later Mac execution verifies the finished implementation, not an implementation handoff.
