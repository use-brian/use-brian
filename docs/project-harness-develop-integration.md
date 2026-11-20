# Project harness: develop integration check

Publication branch: `use-brian-project-harness`.

Checked against fetched develop **`5e2087be93dfa24cb250cd504235b07dfd81eb98`** (`5e2087be9`, “chore(db): keep migration generator filenames private”). The common ancestor is `570d6bce9eb6263063e9d01d844ed21c418c76cb`; develop has 66 commits beyond it. This document records a blocked integration, not a successful merge/rebase, deployment or integrated test pass. Develop may advance after this check.

## Git conflicts

A non-checkout `git merge-tree --write-tree --name-only --messages` simulation returned conflict status 1. The working tree was not merged, stashed, reset or populated with conflict markers. The following 22 paths conflict:

```text
apps/app-web/src/components/live/live-watch-pane.tsx
apps/app-web/src/lib/i18n/dictionaries/en.ts
apps/app-web/src/lib/i18n/dictionaries/ja.ts
apps/app-web/src/lib/i18n/dictionaries/zh-cn.ts
apps/app-web/src/lib/i18n/dictionaries/zh.ts
packages/agent-runtime/src/engine/query-loop.ts
packages/api/src/application-platform/__tests__/connector-runtime-authority.integration.test.ts
packages/api/src/application-platform/__tests__/session-message-publication.integration.test.ts
packages/api/src/application-platform/connector-runtime-authority.ts
packages/api/src/application-platform/model-source-authority.ts
packages/api/src/boot.ts
packages/api/src/context-scope/__tests__/delivery-authority.test.ts
packages/api/src/context-scope/native-invocation-evidence.ts
packages/api/src/context-scope/resolve-turn-scope.ts
packages/api/src/db/session-message-publication.ts
packages/api/src/inter-assistant/executor.ts
packages/api/src/mcp/inject.ts
packages/api/src/routes/channel-pipeline.ts
packages/api/src/routes/chat.ts
packages/api/src/routes/public-turn.ts
packages/api/src/turn/prepare.ts
packages/api/src/workspace-access/session-create-admission.ts
```

The singleton publication and MCP injector paths are **modify/delete** conflicts: develop deleted the older ports. Develop also moved engine code into `packages/agent-runtime`; simply choosing this branch's older files would discard the new runtime/conversation architecture. The remaining conflicts include source admission, connector authority, chat/delivery/turn integration, Live UI and four locale dictionaries.

## Migration conflicts not detected as duplicate Git filenames

The initial source audit pinned `5bbb8471a`. A final fetch advanced develop by two commits to `5e2087be9`: migration execution/fixture ACL-order handling and generator-local filenames changed, but no migration SQL files changed. The latest-tip merge simulation retains the same 22 conflict paths and the registry incompatibility below. Successor replay must include the updated migration execution path, not SQL files alone.

The migration runner sorts **complete filenames lexicographically** across its migration directories and rejects duplicate complete filenames, not duplicate numeric prefixes. Four branch prefixes are already used by develop:

| Branch migration | Develop migration |
|---|---|
| `8269_project_harnesses.sql` | `8269_canonical_conversation_publication.sql` |
| `8270_project_harness_verification.sql` | `8270_retire_association.sql` |
| `8271_project_chat_creation_admission.sql` | `8271_refresh_recovery_capture.sql` |
| `8272_native_helper_attestation_cost.sql` | `8272_durable_conversation_publications.sql` |

These are different filenames, so Git alone does not report migration add/add conflicts. Their effects nevertheless interleave. The five-digit `82690_private_transcript_preparation_eligibility.sql` sorts before both `8269_*` files. Develop currently continues through `8328_conversation_graph_frontier.sql`.

### Attestation is a semantic/catalog incompatibility

The branch's 8272 cannot safely follow develop's canonical conversation publication unchanged:

- Develop 8269 changes native/retained helper rosters and comparator bodies, changes the native registry to full `pg_proc` records, makes `native_turn_contract_helpers.contract` non-null and drops its `fingerprint` column.
- Branch 8272 authenticates the historical root template/closed roster, constructs predecessor catalog snapshots, and reads/updates `native_turn_contract_helpers.fingerprint`.
- Thus a predecessor-root refusal is expected before the later missing-column failure. Merely assigning a new number does not repair the contract. Moving the compiler before develop 8269 would change the exact predecessor pins develop authenticates, so that is not a safe shortcut either.
- The branch compiler also deliberately requires UTF8/PostgreSQL 18 and an exact catalog shape. Do not weaken that check, enroll discovered functions dynamically, or replace expected hashes with observed database state to make replay pass.

### Historical Memory migration boundary

Develop removes `8268_native_memory_query_write_lineage.sql` from the source chain and adds `8326_native_memory_query_write_contract.sql`. A database that already applied 8268 retains its effects and ledger row. Develop 8326 recognizes that exact old ledger name when authenticating refresh-recovery state. Do not erase/rename its history or treat a renamed migration as already applied without an authenticated identical-effect transition.

### Admission and foundation ordering

Keep harness foundation before verification. The branch's 8271 authenticates the predecessor `require_session_creation_admission()` body, metadata, owner/private ACL and trigger registration before adding its narrow Project branch. The audit found no direct develop rewrite of that routine, but that is not a replay pass. Unique successor filenames and references in tests/upgrade boundaries/docs must be chosen only after the successor-contract design is settled.

## Required integration gates

The PR must remain **draft/not merge-ready** until the runtime/conversation integration and migration design are reconciled against the then-current develop:

1. Preserve develop's canonical conversation/runtime architecture; transplant the scoped harness and repair behavior into its current ports rather than accepting obsolete files wholesale.
2. Design the attestation optimization against the successor registry, or explicitly defer/supersede it with an authenticated upgrade plan. Do not silently drop already-applied effects or weaken any authority/source/CAS/private-ACL/closed-cohort/pin-consumer check.
3. Assign globally unique migration filenames and update all test/document/upgrade-boundary references without pretending renamed DDL was already applied.
4. Use owned **disposable** fixtures for separate fresh-chain, develop-tip→branch-additions, branch-applied 8268/harness-prefix→merged-chain, and any actually applied local candidate boundary replay. Preserve canonical separate non-owner application-role checks and existing deadlines. Do not apply the speculative chain to a live database.
5. Rerun current typechecks/builds, source/metadata/ACL tamper rejection, receipt/CAS/concurrency, live authority/revocation, credential isolation, source provenance, UI recovery and actual coding/review gates on the integrated tree.

The migration ledger is filename-based, not a content checksum, and SQL effects and ledger insertion have separate failure boundaries. Numeric renaming is not an upgrade strategy.

## Existing evidence and limitations

Fresh checks during PR packaging, on the unchanged branch implementation: **168 core tests/9 files, 244 API tests/13 files (serial `--maxWorkers=1`), 42 web tests/4 files** passed; API and web typechecks passed. The initial parallel API attempt hit the existing 10-second PGlite setup-hook limit and two subsequent duplicate-function cascades; the unchanged serial rerun passed 244/244. No fixture hook, production SQL or provider deadlines were increased. These 454 checks are focused branch regression evidence, not an all-suite or integrated-develop pass.

The branch has focused pre-integration core/API/web and ordinary-owner native replay evidence documented in `docs/brian-chat-recovery-status.md`, including 168 core and 20 native/HTTP checks for the final input-recovery repair, API typecheck and core/API builds. These are **branch** results, not a successful replay or test run of the simulated merge. The broader elevated-owner suite differences, compaction timeout and independent page acceptance remain open. No live migration, policy/deadline change or repository-access expansion was made for this integration check.
