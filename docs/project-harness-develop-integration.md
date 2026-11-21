# Project harness: rebased develop integration

Branch: `use-brian-project-harness`; PR: https://github.com/use-brian/use-brian/pull/497.

Rebased onto **`5e2087be93dfa24cb250cd504235b07dfd81eb98`** (`develop`, checked again against origin after verification). The previously reported 22 Git conflicts are resolved. Develop's current conversation store, original turn owner, modular MCP activation and `packages/agent-runtime` layout are retained; deleted legacy publisher/injector files are not restored. The original published head `7860293c00dd415639869b9de078b642e1c879dc` is also preserved in a local backup branch.

## Migration resolution

For the merge into develop at `53d9f5d7f`, the harness migrations follow the published 8334 migration:

| Successor | Responsibility |
|---|---|
| `8335_project_harnesses.sql` | Harness hierarchy, revision history and scoped authoring. |
| `8336_project_harness_verification.sql` | Independent approval, human evidence, verification history and audit. |
| `8337_project_chat_creation_admission.sql` | Exact one-use admission for shared Project chat roots. |

Foundation and verification SQL are byte-identical to the previous branch candidates; migration names and test/upgrade boundaries change. No published develop migration is rewritten.

The old branch 8272 helper compiler is **superseded**, not blindly renumbered. Develop 8269 replaces fingerprint hashing with executable-record comparison, and 8274/8276 establish the portable **`native_executable_contract_v1`** registry. The incompatible compiler and its obsolete compiler-specific unit test are removed from the active source chain. New coverage instead verifies the current source-owned installation, metadata tamper refusal, private registry ACLs and unsupported candidate boundaries.

8337 verifies the current portable registry before changing shared Project admission. The portable restore profile builds on the 8334 authentication proof. It authenticates the exact predecessor trigger body/metadata and either its owner-only ACL or the one source-reviewed historical non-grantable `app_user` EXECUTE edge, narrowing only that edge before installing the successor. Receipt equality/consumption, live person+assistant membership, Project-only audience, clearance, original actor, trigger identity and unknown-pin-consumer refusal remain enforced. Its before/after proof ports are the complete current `native_turn_helpers_current`, `native_turn_publication_contract` and `native_retained_helpers_current` cohorts, not obsolete legacy batch helper names. It does not repin unrelated helpers or turn observed database hashes into authentication roots.

Both native and embedded entry points check candidate compatibility **before ledger creation, recovery or rename aliasing**. The native runner uses the existing atomic migration path for all three successors, applying the SQL effects and recording each receipt in one transaction. Lost-acknowledgment continuation is tested.

## Previously applied candidate: explicitly unsupported

An already-applied old harness/admission/compiler candidate is **not silently upgraded**. Old ledger names, compiler markers and unreceipted/partial effects fail with `project_harness_candidate_upgrade_unsupported`, preserving effects and ledger rows. Develop's existing 8268 Memory transition remains intact and is not misrepresented as authentication of the old harness/compiler candidate.

This includes the earlier local 755-migration Brian fixture. A supported transition would require a separately pinned, authenticated bridge and dedicated replay. Do not delete its ledger rows, rename already-applied DDL, rebaseline fingerprints, reset its data or restart it expecting an automatic upgrade.

## Runtime and UI ports

- Harness grounding runs after Brief assembly through `captureTurnModelPreparation` under the original owner. The accumulator is adopted at model-invocation binding for all five lanes, including lanes without history; history and later loop input cannot replace it. Resolver capture precedes awaits. Canonical actor identity, tool adoption, source admission and final authority remain enforced.
- Source candidate re-admission retains current conversation-record/frontier proofs and retries only successful superseded snapshots, with 32-candidate bounds and sticky genuine failures/cancellation.
- Connector activation rechecks current audience exposure on invocation and return; canonical metadata ignores label projection but never ambient identity mismatch.
- Singleton publication uses develop's canonical one-element batch path and format 2 sealed frames, including immediate-constraint mode. No obsolete writer is reintroduced.
- Rejected-input recovery lives in agent-runtime, without a reverse runtime→core dependency. Exact valid calls still reach normal Ask; rejected history/diagnostics cannot become executable calls or approvals.
- Live retains the shared conversation controller and one stream. Pending recovery is single-flight, preserves input on transient failure, retires only unchanged stale cards on authoritative readback and fences pre-completion responses. Removal is presentation state, not a fabricated approval/denial or consent replay.

## Historical verification before the merge into develop

- **661 API harness/owner/migration units**, **86 source-race/activation/singleton units**, **125 connector/ceiling units** passed.
- **84 runtime recovery units**, **90 Codex-provider units**, **15 core MCP-schema units** passed.
- **247 shared-controller/Live/SDK units**, **44 harness frontend units**, **23 chat-reducer units** passed.
- Guarded verifier argument/environment tests passed. API, runtime and web typechecks and API/dependency builds passed.
- Actual guarded PostgreSQL 18 ordinary-owner verifier passed **fresh**, **develop-tip→successors**, and **pre8330 hierarchy/history preservation** runs: 16 native tests in each, **48 test executions**. Each independently authenticates the source-owned 8328 installation after the additions. The develop-tip run also proves unchanged native contracts across the additions. Committed synthetic historical-ledger/effect markers are refused by the actual runner without state changes; these are refusal tests, not a full candidate bridge.
- A separate fresh ordinary-owner fixture with restricted non-owner `app_user` passed **24 native/real-loopback-HTTP tests in four files**: connector authority, canonical singleton/error closure/lineage/debt/rollback, Project admission/source proofs, and rejected-input/analytics/history/replay with exact synthetic allow/deny forwarding. No coding agent is launched by the test endpoint.

Commands use the existing infrastructure:

```sh
node scripts/project-harness/verify-postgres.mjs --pg-bin "$PG_BIN"
node scripts/crm/local-fixture.mjs --pg-bin "$PG_BIN" --ordinary-owner --runtime-role app_user -- \
  pnpm --filter @use-brian/api exec vitest run --config vitest.integration.config.ts \
  src/application-platform/__tests__/connector-runtime-authority.integration.test.ts \
  src/application-platform/__tests__/native-singleton-publication.integration.test.ts \
  src/application-platform/__tests__/rejected-tool-input.integration.test.ts \
  src/routes/__tests__/sessions-workspace-project-admission.integration.test.ts --maxWorkers=1
```

Initial replay failures exposed the portable registry type, retired helper names and stale test assumptions; these were corrected against published source, not bypassed. No SQL/provider/fixture deadlines, authority checks, source closure/CAS or application-role restrictions were relaxed. These initial focused checks alone did not establish full embedded-chain replay or broad all-profile/release acceptance; the subsequent CI repair adds the specific historical-owner replay below.

## PR #497 CI repair

The first rebased CI run exposed five failing jobs, with three distinct test-port assumptions and two integration gaps:

- API delivery snapshot tests now require a fresh admission of current evidence after a successful superseded candidate, rather than unconditional refusal. Added assertions retain sticky genuine errors, the 32-attempt bound, cancellation, identity/access changes and disposal refusal.
- The owner-wiring source assertion now requires the privately retained invocation accumulator to be forwarded and checked, not the obsolete two-argument call.
- The frontend ownership test now settles attachment's initial single-flight read before changing the synthetic response. It additionally checks 503/network preservation and authoritative empty clearing; no production recovery behavior was weakened.
- The historical-owner full embedded replay proved that only the admission trigger's ACL differed: an inherited `app_user` EXECUTE grant from the supported legacy chain. 8331 authenticates the unchanged source/metadata and exact finite ACL profile, refuses unexpected principals/grant options/PUBLIC/defaults atomically, then removes only that edge. It preserves OID, owner, trigger registration and unrelated defaults. The original **owner-legacy replay passed 92 assertions**; the focused migration unit suite passed **35 tests**.
- Portable restore needed a real release extension, not a count adjustment. A pinned 8328 baseline classification adds exactly seven durable tables; the 8331 release profile composes the current 8328/CRM proof with exact source-pinned harness schema/routine/ACL/trigger metadata in the same authentication snapshot and requires all three successor receipts. Unknown names/overloads/drift remain refused. The roster has **603 tables / 807 migrations**. The 8273 cohort is unchanged. The expected artifact generator accepts no connection URL: it creates a new owned ordinary-owner fixture, validates the pinned recipes and reviewed classification, and generates/checks only that fresh source installation.

A real two-installation PostgreSQL 18 portable proof passed: distinct catalog OIDs, all seven populated harness tables, two revision histories, independent approval, terminal human run/evidence, exact three-event audit without duplicate trigger effects, exact row digests/timestamps/attribution, immutable history, restricted-role denial, live-session guards, 18 archive/catalog/receipt refusals and withheld activation until receiving proof. Both disposable fixtures were disposed; all 807 migration files and 207 pinned proof sources remained unchanged. This supports the current shipped source release, **not** an upgrade of the historical 755-migration candidate.

Parent reruns of the original ordinary CI shards passed: API **2/4: 3,165 tests**, API **3/4: 2,887 tests**, web **3/4: 1,935 tests** (existing declared skips unchanged). API typecheck passed. The guarded native verifier passed all three modes again with **17 tests each / 51 executions**. Targeted owner-wiring/delivery units and frontend recovery suites also passed. Broad all-profile/release acceptance and the separate page acceptance remain unclaimed; the pushed revision still needs its own GitHub CI result.

Reproducible portable commands (owned disposable fixtures only):

```sh
node packages/api/scripts/conversation-store/build-portable-harness-catalog.mjs --pg-bin "$PG_BIN" --check
node packages/api/src/application-platform/__tests__/fixtures/portable-restore-proof.mjs \
  --pg-bin "$PG_BIN" --evidence "$NEW_PRIVATE_EVIDENCE_DIRECTORY"
```

## Live and release limits

Only the owned Brian dev launcher was stopped before checkout changes, to prevent hot reload against the incompatible old fixture. Its descendants are stopped; gateway/coding/database services were not stopped or migrated. Brian is intentionally **not restarted** on that old candidate database. Private runtime/credentials, page fixture and unrelated worktrees are excluded from publication.

These source checks are not a new live UI/coding acceptance run. Historical compaction/provider/resume investigations, generic Ask recovery, broad release gates and independent acceptance of the separate introduction page remain distinct. Keep the PR draft until those applicable release/review gates are satisfied; a conflict-free rebase is not release acceptance.
