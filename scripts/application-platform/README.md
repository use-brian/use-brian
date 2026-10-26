# Reference operations app

This runnable CLI creates canonical company/deal records with the public SDK and
changes the same IDs through registered application MCP. No model invocation is
needed. The source phase configures a read/wait/read background workflow through
supported management and workflow HTTP routes.

Use an isolated fresh workspace with its existing default access-policy setup
(`legacy`) and a primary assistant. Do not downgrade a configured workspace.
Ready-mode wait-step job inheritance is currently refused with
`operational_authoring_proof_required`. Native app access remains independently
governed by scoped activation, grants and current credential authority.

## Host composition

The native CLI below uses canonical CRM `native` and does not need purchasing.
The purchasing browser/reconciliation clients require the explicit fixed OSS
`scripts/rig-up.sh --admin-only --reference-applications` host. Normal OSS and
hosted boot omit it. Switch owned modes only after
`scripts/rig-down.sh --admin-only --keep-db`; preserve installed app/schema/binding,
credential and receipt identities, without redeploying/reseeding. Administrative
mode has no workers, so the separate source-workflow CLI is not qualified there.

## Native app

Start the installation using the maintained local rig or your normal deployment.
Sign in as workspace owner/admin. Use that native authenticated session bearer;
an application credential cannot configure this app or retrieve its secret.
For local development the rig writes the owner bearer to its documented token
file. Keep tokens in the environment, never in command arguments or source files.
The management Origin must be in the installation's configured allowed origins.

From the OSS repository:

```sh
pnpm --filter @use-brian/brian-app build
node examples/application-platform/build.mjs output/application-platform/reference-web
export BRIAN_NATIVE_TOKEN='<native session bearer>'
export BRIAN_MANAGEMENT_ORIGIN='https://your-web-origin.example'
node scripts/application-platform/reference-operations.mjs native --apply \
  --api https://your-api-origin.example --workspace '<workspace UUID>'
```

The client registers an API app, prepares a service, reviews/applies scoped
activation, reviews/applies company and deal grants, and delivers its credential
once. It creates, queries and reads records through the shipped server-only service-bot
client from that build (using the public SDK), and patches them through
`applicationCommand` on the registered `/api/applications/:appId/mcp` endpoint.
It also creates a separate retirement demo deal, closes it with the existing
set_deal_stage command using stage lost, and reads it back through the SDK.
This is CRM v1 soft retirement: the closed deal remains queryable with its history.
There is no hard-delete support in this example or its scoped profile; see
docs/architecture/features/crm.md. It prints the active and retired demo IDs and
revokes its demo key, retaining the canonical records.
The authenticated native member read is also exercised by the SQL integration
proof. Save the printed app ID and service user ID for the source phase.

## Independently approved source and wait workflow

Deployment prerequisites are existing product trust/runtime setup, not authority
created by this client:

1. Configure a connected custom workspace connector instance with its source MCP
   URL and transport credential using the supported connector setup. The source
   must implement the governed `/http/read` protocol, signed current receipts,
   principal discovery and independent resource/field/action authorization.
2. Configure the installation's existing active Ed25519 connector-actor signing
   issuer/key and let the independent source trust its public key, issuer and
   audience. The app management route never mints deployment signing keys.
3. In the source's own authenticated administration UI, approve the configuring
   native human and the printed actual service user, each with the executing
   primary assistant. Approve only the selected record/fields and
   `read`, `context`, `derive`, `retain` actions. This is independent source consent;
   Brian grant approval cannot substitute for it.
4. Run the maintained API scheduler. The example waits one minute. Profile and
   binding expiry, app/grant/key revocation and source permissions remain current
   checks at execution and wake-up.

```sh
node scripts/application-platform/reference-operations.mjs source --apply \
  --api https://your-api-origin.example --workspace '<workspace UUID>' \
  --app '<printed app UUID>' --service-user '<printed service UUID>' \
  --source-instance '<configured instance UUID>' --tenant fictional-tenant \
  --audience https://source.example --record order-1 \
  --fields description,cost --type purchase
```

This reviews/applies a source profile after a real source probe, issues a native
bootstrap key, prepares a binding, reviews/applies the independently approved
external grant, reissues a combined key, revokes the bootstrap binding/key, creates
the workflow over HTTP, activates the matching workflow binding and starts it.
The replacement credential secret stays in memory and is never printed. The
binding expires after 20 minutes; the credential expires after one hour. On setup failure the client attempts to revoke known unused keys/bindings and
prints only nonsecret recovery IDs. A possibly started run is preserved for
explicit reconciliation. Printed nonsecret credential/binding IDs allow explicit native revocation later through
`credential.revoke` and `source.binding.revoke` management commands.

A protected run returns HTTP202 with `accepted:true`, `effect:'committed'`,
`runId`, and `outputUnavailable:true`. This means local run creation/start was
accepted. It does **not** mean workflow completion or successful remote effects.
Protected run and step history stays withheld from the configuring human. Do not
automatically retry a held response, network error or uncertain effect. To create
a deliberately separate run after inspecting existing execution, use:

```sh
node scripts/application-platform/reference-operations.mjs start --apply \
  --api https://your-api-origin.example --workspace '<workspace UUID>' \
  --workflow '<printed workflow UUID>'
```

For permission withdrawal, start a separate run explicitly, revoke the service's
selected record in the independent source's own UI during the wait, and let the
maintained scheduler wake it. Its next read fails current authorization; no
author fallback or protected output becomes visible. The integration proof uses
the independent source fixture's authenticated `/ui/grants` UI adapter, claims
the persisted due job and dispatches the same handler used by production boot.
It advances only the fixture clock deadline so this check does not sleep a minute.

## Reproduce the supported-route proof

This runs a disposable local PostgreSQL fixture, not a live workspace:

```sh
node scripts/crm/local-fixture.mjs --pg-bin /opt/homebrew/opt/postgresql@18/bin -- \
  pnpm --filter @use-brian/api exec vitest run \
  --config vitest.integration.config.ts --no-file-parallelism --maxWorkers=1 \
  src/application-platform/__tests__/scoped-journey.integration.test.ts
```

Use your PostgreSQL18+ binary directory. The proof invokes both shipped native and source client functions against real supported routes, and checks source profile approval,
reissue, binding, HTTP authoring/start, persisted scheduler wake-up and revoked
source failure. Only native session/deployment/source-operator bootstrap and
fictional source records are fixture setup. App credentials, grants, activation
and qualified source profiles are produced by their supported management paths.
The source CLI phase uses the same commands; its external deployment prerequisites
are supplied by the operator. Portals, additional clients, ready-mode wait
inheritance and remaining broad consumer/retention acceptance remain backlog.

## Import guarded campaign evidence

Capture each relevant source set before its command starts. Supply the exact
current source hashes in that run's `input.json`, then run
`node scripts/application-platform/verify-local.mjs --run <safe-id> --capture-snapshot`.
The snapshot records both repository heads and refuses changed inputs or an
existing snapshot file. Use a separate safe run for a later source generation.

An imported receipt file has `kind: "guarded-command-import"` and checksum-bound
`guard`, `snapshot`, `log` and (for Vitest JSON) `result` references plus `format`.
The guard and log paths must be matching `.json`/`.log` siblings. The verifier
preserves the guard's exact argv and cwd and matches them against its reviewed
gate catalog. Snapshot time must precede actual launch, all inputs must still
match, the owned command group must have started, and machine test results must
show concrete passing cases with zero skips. This adapter never executes JSON
commands or treats a source report as runtime authority. A missing browser,
consumer, migration, case or required gate still makes collection incomplete.

Browser receipt imports use `kind: "maintained-rig-browser-import"` with the normal guard/snapshot/log/format refs, plus `rig: {guard, snapshot, log}` for the actual bounded maintained administrative boot and `artifacts` containing checksum-bound PNG and JSON observations. The reviewed operations desktop/phone and portal command recipes retain exact `node` argv. Missing browser commands such as management remain incomplete until a real reviewed harness is added. The final manifest declares `commandSources[id]` as the exact relevant input list for each receipt; those inputs must match its prelaunch snapshot and the final frozen source map. Historical browser milestones from a moving tree cannot become current acceptance by relabeling them.

`upgrade-rehearsal.mjs <run> fresh|upgrade oss|overlay <pg-bin> [overlay-dir]` creates and disposes its own actual PostgreSQL fixture. Its upgrade callback runs once immediately before real migration8000, creates fictional prefeature data, and starts bounded nonowner old-reader traffic before migrations continue. The dedicated upgrade integration suite refuses ordinary fresh-fixture execution without that observation. Run it through this orchestrator as a separate gate, never rename a fresh install as an upgrade.

Future gate catalogs resolve an explicitly selected PostgreSQL binary directory to its real path before generating argv, matching the CLI selection. Empty selection remains valid for collect-only inspection. The exact generated argv is captured before launch; historical aliases/receipts are never rewritten. Use the maintained capture-snapshot command for actual prelaunch source hashes and both repository heads, rather than hand-assembling incomplete snapshots. Parameterized public-docs render tests include each real locale ID in their test title so concrete machine case identities remain unique; reports are never renamed after execution.

The maintained reconciliation browser recipe requires `fixturePgPort` and its matching
`nativeSessionPath` in `operations-browser-inputs.json`, just like credential proof.
It reads only the selected disposable rig container to count the committed receipt,
audit, event and records after actual authenticated browser reconciliation.
