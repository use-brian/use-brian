# Native computer: non-production backend readiness

This is a read-only setup check, not Mac acceptance or a deployment command. Use an existing authorized **non-production** API/relay, normal authenticated account and configured provider. Do not provision credentials, mint test JWTs, use dev-login, fabricate grants, change production, or enable acceptance flags for this check.

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

API: `NATIVE_COMPUTER_ENABLED=true`, nonempty `NATIVE_COMPUTER_DEPLOYMENT_ID`, stable existing `JWT_SECRET`, `BROWSER_RELAY_SECRET`, `BROWSER_RELAY_URL`, and normal database/auth/provider settings. Relay: native enabled, matching existing JWT/relay secrets and explicit `HOST`/`PORT`. Direct entrypoints need their environment supplied; do not assume the root `.env` is loaded identically by every package.

Set `BROWSER_RELAY_URL` to the relay's **HTTPS** base (HTTP only for permitted loopback), not a `wss:` URL: API readiness/commands use HTTP fetch. Session exchange converts that same base to the desktop's WebSocket URL. It must be reachable by both API and Mac, using HTTPS/WSS except loopback development. Linux localhost is not Mac localhost. Reverse proxies must preserve the native HTTP and `/native-computer-v1` upgrade paths. Readiness cannot prove topology/affinity or WebSocket/JWT compatibility.

The normal database must already have migrations `620_native_computer_sessions.sql` and `621_native_usage_receipts.sql`. `pnpm --filter @use-brian/api migrate` is the existing **writing** migration command: it is never run by readiness. Separately confirm the non-production database destination before any migration.

`pnpm dev`/`pnpm start` use the local-owner launcher: they may prompt, generate/persist secrets, start sidecars and create local-owner state. They are not a transparent launcher for an existing authenticated deployment. `USEBRIAN_CORE_ONLY=1` skips its local relay. A cloud login does not create an account in an independent local database. ChatGPT/Codex onboarding alone does not supply a native-strict supported model route.

## Run the checker

Use context IDs from the deployment's normal owned workspace/assistant/conversation/current task; do not invent rows or reuse IDs from another deployment. The intended desktop's existing native `status` response includes `deviceId`. The same UUID is stored in `native-computer-device-id` under that app's Electron `userData` directory; read it without modifying it if needed. Do not generate a substitute device ID: that would miss the actual device's unknown/busy fence.

Use a currently valid access token from the deployment's ordinary authenticated session. Supply it through an existing owner-only regular file (mode 0600 or stricter, no symlinks), or noninteractive stdin. Do not place tokens in command arguments, shell history or reports. The checker never prints token contents, URLs, raw errors or response bodies.

```sh
pnpm native:readiness --non-production \
  --api https://api.your-test-deployment.example \
  --token-file /private/path/existing-access-token \
  --workspace-id "$WORKSPACE_ID" --assistant-id "$ASSISTANT_ID" \
  --conversation-id "$CONVERSATION_ID" --task-id "$TASK_ID" \
  --device-id "$DEVICE_ID"
```

`--token-file -` reads stdin instead, with an 8 KiB cap and five-second input timeout. Use your existing credential manager to supply stdin; do not echo a literal token. `--api` is the API origin, not an `/api` path. HTTPS is mandatory except HTTP localhost/127.0.0.1/[::1]. Credentials, query strings, fragments and redirects are rejected. `--non-production` is the operator's explicit destination acknowledgement, **not automatic proof of deployment classification**.

The CLI sends exactly one authenticated `POST /api/native-computer/readiness`, containing only the five context fields above. POST keeps identifiers out of query-string access logs; this endpoint performs no data writes. The API uses authenticated user/session identity, not client user IDs. It checks migration/schema availability, auth-session liveness, existing membership/capability/task predicates, existing tool-policy blocks, device busy/unknown fences, the same-user/conversation lease across all devices/deployments, and relay readiness. It never expires sessions, constructs grants, clears unknown state, performs accounting admission/reservation/reconciliation, calls a model or dispatches commands.

The API response deadline is eight seconds; relay fetch is five seconds and capped at 1 KiB. The CLI request is capped at ten seconds and its response at 8 KiB. A response deadline does not cancel an already-running SELECT: the normal database statement timeout still applies. Readiness is a point-in-time preflight, not an authorization lease or an atomic multi-query snapshot; normal dispatch revalidation remains authoritative.

Output is a bounded protocol/ready/blockers/warnings JSON object. Exit 0 means the configured checks passed; exit 1 means a blocker or failed check. No retries. `ready` describes **configuration preflight only**, never live model success or native execution.

| Blocker | Operator action |
| --- | --- |
| `native_disabled`, `configuration_invalid` | Verify intended API revision and native/relay settings; do not alter production. |
| `schema_unavailable` | Inspect the selected test database/migration state separately. No automatic migration. |
| `auth_session_denied`, `scope_denied` | Use normal login and owned workspace/assistant/conversation/current task with active native capability. |
| `policy_denied` | Review existing native tool policy through normal administration. Checker never changes it. |
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

Do not leave an outer `requireAuth` before this helper: ordinary auth updates `last_seen_at` for sessions older than five minutes. `nativeComputerAuth` selects `requireAuthWithoutTouch` only for the readiness POST (including normal Express case/trailing-slash variants). Every other native route retains ordinary touching authentication. Both use exactly the same JWT signature/kind/expiry, UUID, user auth-version and session owner/revocation/expiry admission; only the optional activity UPDATE is suppressed. Request headers/body/query cannot opt other routes out of touching. The readiness route still independently requires a session-backed identity. No auth bypass or refresh/session creation is introduced.

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
