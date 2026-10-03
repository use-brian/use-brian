# RETIRED — no emitting cases

The real operator `last-check-to-post` counterexample retired the pair emitter.
`Adapter.swift` no longer allocates, posts, or returns replacement mouse events.
Only the harmless tagged **null probe** remains runnable. There is no CLI, flag,
environment variable, consent choice, or test override to reactivate emitting cases.
Production admission is unconditionally false and click execution refuses;
adding source profiles alone cannot enable production.

**A git pull does not neutralize old built binaries or running processes.** Do not
launch old artifacts (including a directly invoked app), refresh their identity
to reuse them, or rerun native effects. Old binaries must be kept out of use;
process termination cannot retract queued OS events. No native case needs to be
rerun to interpret the preserved evidence. Uncertain historical cleanup stays
uncertain, not proof of release or queue drain.

## Current interface and portable verification

```sh
cd apps/app-desktop/native/computer-control/tests/native-acceptance
node --test portable.test.mjs
```

This runs offline report/source regressions, shell syntax and C layout checks,
and a compiled synthetic-only C bootstrap policy test (131 checks, no native APIs).
It does not launch the native app or produce native effects.
`bash build.sh` is Mac SDK compile-only; native compilation is not established by
portable tests. A newly built `node run.mjs --run null` is the only admitted run,
requires attended disposable-login GUI consent, and is **not needed** for this
retirement. Existing permission, scope, neutrality, timeout, lifetime and
bootstrap checks remain; null success never grants production acceptance.

JS uses `runnableCases = ['null']`. Swift `--case` rejects every other name before
supervisor initialization, child admission checks the config, and owner init
rejects nonzero indices before subscriptions. C consent, root config, start,
launch, grant issuance/acceptance and topology policy independently deny nonzero
scenarios before downstream launches. No direct native role bypass is provided.
Original PID-bound grants, peer credentials and epoch fences still apply.

## Historical evidence — NOT actionable run instructions

The following describes the **retired implementation**, not supported commands
or instructions to perform these actions. All twelve names and their indices
(0–11 in table order) remain fixed in `historicalCases`/`Scenario` for offline
classification. Only index 0 is runnable. Historical fault/sample codes and
conservative report rules are retained; historical case names are not authority.

| Case | Actual fault / collection |
| --- | --- |
| `null` | One tagged null probe; owner and downstream correlation, no pair. |
| `normal` | Null probe, distinct null wake, one preallocated pair, independent downstream and fixture receipts. |
| `paused-before-final-check` | SIGSTOP after allocation, before the final scope/neutrality/deadline checks; resume after three seconds. |
| `last-check-to-post` | SIGSTOP after the final checks/sealing and before `tapPostEvent`; resume after three seconds. |
| `after-down-stall` | SIGSTOP after down insertion returns, before returning the retained up; resume after three seconds. |
| `after-down-owner-death` | Same boundary, then kill the stopped owner instead of resuming it. In-flight state remains inconclusive. |
| `worker-death-before-check` | Stop before final validation, kill the actual worker process, observe exit, then resume. |
| `parent-death-before-check` | Same, killing the owner's **actual OS parent**, not a sibling stand-in. |
| `worker-death-after-check` | Stop after final validation, kill worker, observe exit, resume into the posting boundary. |
| `parent-death-after-check` | Same with actual parent death/reparenting. |
| `physical-overlap` | Stop after final validation. Operator presses and releases the fixture target during the three-second cue. Observe untagged traffic and resumed stale sequence. |
| `physical-before-check` | Stop before final validation. Hold left on the target until **SAMPLE RECORDED**; release manually only after that cue. The actual resumed final sample must establish held-left and nonneutral input. |


The old emitter inserted a down through the callback proxy and returned a retained
up. That sequence is removed, not repaired with another last check or a longer
deadline. Historical suspension, physical-input and release-cue descriptions
above must not be followed. The retained supervisor collection vocabulary allows
old reports to remain interpretable; the owner cannot dispatch these cases.

## Historical records, verdicts and limits

Sources: 0 supervisor, 1 independent observer, 2 fixture, 3 owner, 4 supervisor
fault/lifecycle control, 5 real parent. `Model.swift` defines the code values;
`report.mjs` constrains which source may produce each. In particular:

- 10–22: probe, arming, callback/check/insertion/return/fencing phases;
- 40–47: downstream null/pair/ordinary-traffic/tap-disable observations;
- 60–64: fixture pair and untagged-button receipts;
- 80–86: timeout, lifetime observations, scope/monitor state, callback resume;
- 90: actual stopped status acknowledged by the parent;
- 92/93: tap enabled/disabled sampled immediately after resume;
- 94: independent observation window closed;
- 95/96: liveness loss/deadline expiry sampled after resume;
- 97/98: consistent held-left / not-established held-left at final check;
- 99/100: neutral / nonneutral sample at that same final-check boundary;
- 101: supervisor's sample-received release cue (held-input case only).

“Physical” record names mean **untagged traffic in an explicitly attended
exercise**, not authenticated hardware provenance. Tags correlate only. The
fixture counts a pair only after a tagged target down followed by a tagged up;
that is application receipt, not global drain or exclusive press ownership.

The checker requires a complete bounded observation window, real reached phases,
source-local record continuity, final supervisor/observer/fixture/control record counts, null confirmation and required downstream/fixture
receipts. Unknown/extra fields, overflow, observer disable, scope loss, missing
phases or ambiguous process termination cannot produce a positive verdict.

- `observed-as-specified` (exit 0): narrow observations/refusal criteria only.
- `blocked` (exit 2): consent/preflight/build/launch unavailable.
- `inconclusive` (exit 3): missing phase/evidence, partial input, ambiguous loss.
- `counterexample` (exit 4): concrete unexpected ordering/duplicate/input after
  the observed disabled or liveness-loss boundary.

**Observed deadline counterexample (operator, arm64 25G83):** the preserved
`fixtures/operator-last-check-to-post-25G83.json` observation came from binary
`0ce85768103d6144c98318a99e97eb7e50d2a1f1dc5ff99d9ec14ab476335f40`.
After suspension past the final check, the owner sampled deadline expiry, then
inserted a new down; the independent observer and fixture received the pair.
The tap still reported enabled. The old classifier called this inconclusive
because disablement was missing; it now independently reports
`counterexample / new-down-observed-after-deadline`. This does not establish
behavior of a disabled proxy or the full production Host. Regression mutations
require expiry-before-insertion and downstream down evidence; an up from an
already-in-flight pair is not mislabeled as a new-down deadline violation.
All emitting cases are permanently retired in this source. Do not
rerun native effects to reclassify existing evidence or lengthen the deadline
to hide this result; a last check alone is not atomic with posting.

A delayed disabled notification alone does not establish that the tap was already
disabled when resumed: the stale-proxy counterexample requires the actual resumed
`tapIsEnabled` sample to be false. No downstream event in eight seconds is **not**
proof that insertion was dropped or no event remains pending. Finite clean trials
cannot establish the absence of a race.

Every result has `productionAcceptance: false`, including successes. No code reads
reports back into production. Build identity contains bounded SDK/compiler data,
source hashes and binary hash; runtime adds architecture and OS/build string.
Nothing is uploaded or automatically persisted outside the explicit build output.

The GUI closes collection at eight seconds; the real parent and runnable children
also have independent bounded lifetimes. The runner requests graceful cancellation
at 90 seconds, then reports uncertain process state after another 20 seconds if
necessary. It does not blindly kill an unresponsive supervisor and claim cleanup.
SIGSTOP prevents a stopped owner's own alarm from executing. **Simultaneous loss
of supervisor and parent while owner is stopped is outside this finite matrix and
can strand the stopped process.** An unresponsive/abnormally exited supervisor or
uncertain resource report requires ending the disposable login, not running more
cases. Even known process termination cannot retract OS events.
