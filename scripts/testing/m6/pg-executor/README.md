# Fixture executor calibration

This opt-in PostgreSQL18.7 fork is test tooling. It must build into an explicit
scratch prefix and must never replace the managed release runtime. The source
tarball, patch recipe, compiler/configuration and resulting executable hashes
belong in each calibration receipt. Stock baseline and final product runs keep
their original binaries; engine-version mismatch is explicit.

The initial feasibility collector observes execution after optimization without
rewriting Query/Plan/Expr trees. Its separate units are interpreter opcode
dispatch, named specialized evaluator invocation, function-manager invocation,
btree comparison calls and sort-support comparison calls. Function-manager calls
may occur inside an opcode or AM comparison; feeds overlap and are never added
into a permission ceiling. Executed plan-node/AM inventory is separate from the
planned inventory. Unsupported executed AMs/JIT or unknown specialized paths fail
coverage. Planned nodes that never execute do not constitute observed work.

Scalar-array operations also report direct linear comparisons, hash-table key
hashes and key equality calls, and the non-strict null-right-hand fallback.
The callbacks fire where the evaluator actually calls the operator, so skipped
NULL values and short-circuited elements add no comparison. These feeds refine
the array opcode inventory. They include business predicates and remain
insufficient to calculate a physical permission budget.

The join callbacks identify actual hash-bucket tuple qualification, actual
merge-key comparator calls, and non-null key comparisons on the hashed
subplan's partial-match path. A merge-key comparison is reported in its own
family instead of the general sort callback family. Signed, unsigned, and
full abbreviated-key sort comparisons have separate counters. The inventory
names executed nodes outside the calibrated set and reports their access
method where present. Fmgr totals, evaluator dispatch, and these callbacks
describe different overlapping work.

The permission probes also report ACL entries actually visited during direct
and inherited checks, role membership comparisons and graph inspection, and the
RLS decision that led to policy application or bypass. Planning and rewrite
records keep their own phase. The planner records evaluated constant
expressions, evaluated constant functions, successful SQL inlining and
strict-NULL simplifications. A successful rewrite and a cached execution are
different observations. These feeds are separate from executor counters and do
not establish who owns arbitrary folded predicates or opaque bodies.

Calibration requires the SAME instrumented binary with the collector off/on,
identical deterministic receiving results and exact chosen-plan representations.
It includes allow/deny predicates, an inlined SQL helper, index-only, hash/merge
joins and a deliberately unsupported executed AM. Instrumented counts are not
latency. Until calibration and actual chat-path coverage are complete, this is
feasibility evidence and cannot qualify physical permission accounting.

## Fixed chat and per-release command

Use the same patched binary for both sides. Install the ordinary fixture
extensions (`pg_stat_statements`, `pg_trgm`, `vector`) in its scratch prefix.
The native chat command builds two owned clusters from the same frozen source,
one with its collector off and one on. It compares received and saved bytes
after exactly twenty frames through the numbered native readers. Calibrate
the engine's chosen plans separately on the same binary and SQL inputs.

```sh
node scripts/testing/m6/pg-executor/calibrate.mjs \
  --pg-bin /abs/scratch-pg/bin --collector /abs/scratch/collector.dylib \
  --source-tar /abs/postgresql-18.7.tar.bz2 --out /tmp/pg-probe-calibration

node scripts/testing/m6/pg-executor/chat-inventory.mjs \
  --oss-root /abs/frozen/use-brian --pg-bin /abs/scratch-pg/bin \
  --collector /abs/scratch/collector.dylib --out /tmp/pg-probe-chat
```

The chat command writes a per-release report automatically. The standalone
`release-profile.mjs CHAT.json TRACE.jsonl NEW-OUTPUT.json` command verifies
that report against the actual foreground statement ledger. Each matching
release records its nested executor starts and individual callback families.
The per-owner node inventory separates structural nodes, partially observed
specialized nodes, opaque function bodies, write paths, and uncalibrated access
methods. A statement can execute nodes in several categories.
The report requires the exact owner invocation count, a complete request
window, and zero collector overflow. The executable labels come from the
reviewed release call sites. The report does not retain arguments or add up
overlapping counters. Pinned permission source attribution, planner-folded
work, and unsupported opaque/JIT/native paths still lack complete coverage.
