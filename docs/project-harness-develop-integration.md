# Project harness: rebased develop integration

Branch: `use-brian-project-harness`; PR: https://github.com/use-brian/use-brian/pull/497.

Rebased onto **`5e2087be93dfa24cb250cd504235b07dfd81eb98`** (`develop`, checked again against origin after verification). The previously reported 22 Git conflicts are resolved. Develop's current conversation store, original turn owner, modular MCP activation and `packages/agent-runtime` layout are retained; deleted legacy publisher/injector files are not restored. The original published head `7860293c00dd415639869b9de078b642e1c879dc` is also preserved in a local backup branch.

## Migration resolution

The new chain follows develop 8328 with unique filenames:

| Successor | Responsibility |
|---|---|
| `8329_project_harnesses.sql` | Harness hierarchy, revision history and scoped authoring. |
| `8330_project_harness_verification.sql` | Independent approval, human evidence, verification history and audit. |
| `8331_project_chat_creation_admission.sql` | Exact one-use admission for shared Project chat roots. |

Foundation and verification SQL are byte-identical to the previous branch candidates; migration names and test/upgrade boundaries change. No published develop migration is rewritten.

The old branch 8272 helper compiler is **superseded**, not blindly renumbered. Develop 8269 replaces fingerprint hashing with executable-record comparison, and 8274/8276 establish the portable **`native_executable_contract_v1`** registry. The incompatible compiler and its obsolete compiler-specific unit test are removed from the active source chain. New coverage instead verifies the current source-owned installation, metadata tamper refusal, private registry ACLs and unsupported candidate boundaries.

8331 requires the 8328 receipt and current portable registry. It preserves the exact predecessor trigger body/metadata/private ACL, receipt equality/consumption, live person+assistant membership, Project-only audience, clearance, original actor, trigger identity and unknown-pin-consumer refusal. Its before/after proof ports are the complete current `native_turn_helpers_current`, `native_turn_publication_contract` and `native_retained_helpers_current` cohorts, not obsolete legacy batch helper names. It does not repin unrelated helpers or turn observed database hashes into authentication roots.

Both native and embedded entry points check candidate compatibility **before ledger creation, recovery or rename aliasing**. The native runner binds each of these exact three successor SQL effects and its ledger receipt in one transaction; lost-acknowledgment continuation is tested. There is no generic numeric-range receipt rule or changed-DDL rename alias.

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

## Verification on the rebased implementation

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

Initial replay failures exposed the portable registry type, retired helper names and stale test assumptions; these were corrected against published source, not bypassed. No SQL/provider/fixture deadlines, authority checks, source closure/CAS or application-role restrictions were relaxed. Full embedded-chain replay and broad all-profile/release acceptance are not claimed by these focused checks.

## Live and release limits

Only the owned Brian dev launcher was stopped before checkout changes, to prevent hot reload against the incompatible old fixture. Its descendants are stopped; gateway/coding/database services were not stopped or migrated. Brian is intentionally **not restarted** on that old candidate database. Private runtime/credentials, page fixture and unrelated worktrees are excluded from publication.

These source checks are not a new live UI/coding acceptance run. Historical compaction/provider/resume investigations, generic Ask recovery, broad release gates and independent acceptance of the separate introduction page remain distinct. Keep the PR draft until those applicable release/review gates are satisfied; a conflict-free rebase is not release acceptance.
