# Home-server chat latency investigation, 2026-10-31

Initial read-only production investigation of `awcjack-home-server`, using
Brian API, frontend, PostgreSQL and tunnel journals. Times below are
Asia/Hong_Kong. Post-deployment validation submitted two ordinary chat test
messages through the UI. No production configuration, application files or
ad-hoc database changes were made by the investigating agent.

## Measured requests

Two completed requests in the same chat ended at approximately 18:44:14 and
18:57:50. Each produced nine reply characters, with no tool calls. The first
had one text delta and the second had two. Their exact input was not read from
the database; they match the reported short test exchanges by timing and size.

| Existing request phase | 18:44 request | 18:57 request |
|---|---:|---:|
| Admission, classification, history and pre-loop preparation | 6.888 s | 12.051 s |
| Context assembly | 0.212 s | 0.169 s |
| Connector/tool discovery and injection | 2.617 s | 2.536 s |
| Prompt preparation | 0.186 s | 0.236 s |
| Loop accounting, including some post-loop work | 13.735 s | 11.919 s |
| Buffered-reply flush | 0.917 s | 6.086 s |
| Remaining post-processing | 6.378 s | 0.585 s |
| **Total** | **30.933 s** | **33.582 s** |

Audience authorization consumed 1.091 s and 1.927 s over nine checks respectively.
Those counters overlap the phases above. They are not extra time to add.
Preparation before entering the loop totaled 9.903 s and 14.992 s.

Existing generic stream completion logs, correlated with the sequential route:

| Stream | 18:44 request | 18:57 request |
|---|---:|---:|
| Pre-reply auxiliary stream | 3.289 s | 4.383 s |
| Main reply stream | 6.747 s | 6.357 s |
| Post-reply auxiliary stream | 5.518 s | 3.113 s |
| Later title stream | 3.294 s | None observed |

These stream durations include the time their async generator is paused for
its consumer. They do not isolate upstream inference, network, or delivery.
The old lines have neither call-purpose nor session correlation; the auxiliary
purposes are inferred from adjacent logs and the deployed route's ordering.
Both topic-classifier calls hit the explicit 2,000 ms deadline and used the
uncategorized fallback. The route awaits the session-state diff after saving
the reply, and can await title generation before sending `done`.

The research classifier's deterministic short-chat expression recognizes
greetings and acknowledgments but excludes `test`, so that input still takes
the model assessment path. Background model selection can use a workspace
custom endpoint; this investigation did not establish the configured endpoint
or exact served model from protected database metadata.

Connector injection rediscovered 95 local tools and two remote tools. Garmin
discovery failed immediately with connection refused on loopback port 8093.
That is a connector defect; the logs do not establish it as the source of the
whole 2.5-second injection delay.

## Host and transport observations

At 19:03 the load average was 0.07/0.11/0.15; 26 GiB of 30 GiB RAM was
available. The API used approximately 626 MiB and had no restarts since 18:30.
The local API health response took 1.36 ms. The unauthenticated public health
request reached a Cloudflare Access redirect in 196 ms; that measures only the
Access edge, not authenticated chat streaming. No PostgreSQL error, deadlock
or statement-timeout lines were found during the two request windows.

These observations do not indicate host resource saturation and cannot rule
out individual slow queries or upstream model/network latency.

## Separate frontend crash

`brian-app-web` exited with SIGSEGV at 18:43:43 and 19:00:18, then restarted
after roughly five to six seconds. Its crash stack begins in
`libvips-cpp.so.8.18.6` during native module loading. Tunnel logs show origin
connection refusals and EOFs around those crashes. The API remained running.

Loading Next.js's own installed `sharp@0.35.4` in an isolated Node process
reproduced SIGSEGV. Loading the core package's separate Sharp dependency
succeeded. Core dumps were disabled for the isolated probes; the running
frontend process was not restarted or deliberately sent the failing request.
This narrows the crash to the deployed Next/Sharp native dependency, rather
than demonstrating a general Node or API failure. The precise binary/linker
cause still needs investigation in the Nix package.

## Instrumentation prepared locally

See [Chat reply latency diagnostics](../chat-reply-delivery.md). New request
milestones distinguish loop start, first delivered reasoning/text, generation
completion, saved reply, loop return and client completion. Counters separate
research/topic assessment, history, compaction, publication, state diff and
title waiting. Provider summaries separate inner-iterator waiting from consumer
waiting and record first reasoning/text arrival, including failure/cancellation.
Only timing metadata and allowlisted model aliases are logged.

These changes require a reviewed application build/deployment before the server
can emit the new fields. Existing production measurements above were obtained
without them. A repeat request after deployment should establish how much of
the remaining delay is authority/query work, provider waiting, and the tail
after visible text. Optimization should then target those measured stages.

## Local validation

- 62 focused tests passed across stream wrappers, turn timing, kernel, runtime,
  and channel authority wiring.
- Core and API source type checks passed; the core script type check passed.
- `pnpm smoke` passed with the mock provider.
- `pnpm test` stopped on 10 unrelated desktop release/keychain test failures
  (two files); 23 Turbo tasks had passed or were cached. The focused results
  above were run independently after that failure.
- The normal platform `pnpm check` launcher cannot start because that checkout
  has a Linux-arm64 esbuild binary on this Darwin-arm64 machine.
  Running the same checker with the working local tsx runtime completed, but
  failed on repository-wide stale component paths, missing KB pairs and other
  invariant findings. Its shared-source doc-cochange advisories also fire for
  this instrumentation-only edit; the logging contract is documented in
  `docs/chat-reply-delivery.md`, and model, scope and delivery behavior is unchanged.
- `git diff --check` passed. No production rollout was performed.

## Post-deployment validation, 20:08–20:11

The operator deployed the instrumentation; the API restarted at 19:56:26 and
emitted the new fields. Two ordinary `test` messages were submitted through the
browser with Pro effort. No production patches or service restarts were applied
by the investigating agent.

### Database contention and failure

The first new test was sent at 20:08:48 and returned `source_unavailable` around
20:09:09, before reaching the main loop. A concurrent request in the older chat
ended at the same time with a 57.251 s total, first text at 39.175 s, and a failed
reply publication. That request recorded:

| Counter | Duration |
|---|---:|
| Research classification | 6.684 s |
| Topic classification, including native evidence work | 17.441 s |
| History read | 2.201 s |
| Reply publication attempt | 15.422 s |

The PostgreSQL journal identifies two statement timeouts at 20:09:09:

- `read_native_attended_memory_evidence` waited at `SELECT id FROM workspaces
  WHERE id=w FOR SHARE`, inside `read_native_session_cohort_evidence`.
- `publish_native_session_message_batch` timed out inside
  `prepare_native_session_message_batch` → `application_session_eval_field` →
  `application_memory_query_domain_state` →
  `application_memory_historical_query_scan` →
  `application_memory_query_context` → `workflow_evidence_envelope_visible`.

Publication acquires the workspace `FOR NO KEY UPDATE` lock before evaluating
its retained sources. That conflicts with the evidence reader's `FOR SHARE`.
The observed reader wait and slow publication are consistent with an expensive
history/source validation holding up another chat in the same workspace. The
exact blocker PID was not captured through `pg_stat_activity`; no specific
blocking transaction beyond these statements is claimed.

The topic classifier's two-second deadline does not bound the native authority
checks: it validates before starting that timer and awaits current evidence
again on timeout and return. A long `topic_classify_ms` therefore does not prove
that the topic model itself ran for that entire duration. The first new test
has no `turn_timings` row because the logger currently emits only after the
request reaches the main loop; pre-loop failures remain an observability gap.

### Successful isolated retry

After those requests ended, the second test was sent at 20:10:48. The browser
received `I’m here.` The request took **28.099 s**, with first text at **15.329 s**.
The following contiguous intervals are derived from request milestones:

| Interval | Duration | End relative to request start |
|---|---:|---:|
| Preparation before loop start | 8.675 s | 8.675 s |
| Main generation and boundary checks | 7.681 s | 16.356 s |
| Reply publication through saved-reply event | 1.161 s | 17.517 s |
| Remaining awaited state/finalization before loop return | 3.336 s | 20.853 s |
| Title and remaining request finalization | 7.246 s | 28.099 s |

Nested counters, which must not be added to those intervals:

- Research assessment: 4.828 s; topic classification: 2.854 s.
- History: 0.449 s; compaction: 0.110 s; connector injection: 0.012 s.
  This new General-scoped chat exposed fewer connectors than the older chat,
  so its injection duration is not a like-for-like comparison.
- Reply publication SQL frame: 0.950 s; state diff: 3.323 s; title wait: 7.216 s.
- Main `gpt-6-sol` stream: 6.715 s, comprising 5.928 s of inner-iterator waiting
  and 0.787 s of consumer waiting. The former includes provider setup and
  authority/network work, not just remote inference.
- The auxiliary `gpt-6-luna` streams took 4.102 s (assessment), 2.854 s
  (state diff), and 3.419 s (title); their consumer waits were approximately zero.
  The topic stream was canceled after 1.609 s, followed by the logged classifier
  deadline fallback. Native checks account for time outside these streams.

The reply was saved at 17.517 s, but the final `done` event waited another
10.582 s. This explains why the UI can keep working after reply text arrives.
No thinking delta was observed in the successful test.

### Remaining frontend failure

The deployed frontend still exited with SIGSEGV at 20:08:05 and restarted at
20:08:10. The API had no restart. No new native-module probe was necessary;
the previous Sharp reproduction and the new crash remain separate evidence
from the database and auxiliary-model delays.

## Follow-up implementation on `fix/chat-speed`

The follow-up addresses the observed auxiliary-model and publication work:

- A conservative exact-message allowlist skips research/topic model calls for
  greetings, acknowledgments and probes such as `test`. Topic results retain
  current authority checks and source evidence. An explicit reply target or
  substantive message keeps normal topic classification.
- A conversation with only trivial admitted user messages keeps its title
  placeholder. A later substantive message can generate a title. Title work
  remains synchronous for substantive conversations; no background task or
  authorization snapshot is introduced.
- State diff skips its model only when there are no open commitments and all
  supplied turns are trivial plain text. Open commitments, tool blocks and
  substantive replies keep the original path.
- Migration `8152_native_chat_publication_frame.sql` reuses a complete private
  Memory frame inside publication preparation. Each eligible dependency trigger
  obtains its own fresh frame. Original source-version comparisons, output
  scopes, mutation checks, workspace locks and canonical fallback remain.
  The final preparation after writes builds a new frame, so an insert-time
  source hold still refuses and rolls back the entire publication.

### Local measurements and regression checks

The same isolated query-backed batch-publication fixture was run immediately
before and after applying migration 8152 in a disposable PostgreSQL cluster.
Counts cover the profiled operation, excluding fixture setup:

| SQL work | Before | After |
|---|---:|---:|
| Total tracked function calls | 71,729 | 53,282 |
| Historical Memory query scans | 34 | 6 |
| Generic current-field reader calls | 34 | 17 |

This is a **25.7% reduction in tracked SQL function calls** and an **82.4%
reduction in historical scans**, on this fixture. These are local work counts,
not a production latency prediction. The publication regression now enforces
a 60,000-call budget when `BRIAN_CHAT_PROFILE_BUDGET=1` is enabled.
An additional cold comparison after the other heavy tests finished measured
0.785 s before and 0.650 s after for the profiled publication call. This single
local sample does not estimate production contention or provider latency.

- 81 focused core tests passed, including substantive messages, explicit reply
  targets, open commitments, tool content and authority refusals.
- 67 database integration tests passed across title publication, actual chat
  read cost, message publication and native Memory history. Coverage includes
  changed sources, private-frame access, policy contention and held history.
  The explicit publication budget passed separately.
- Core/API source and core-script type checks, core build, `pnpm smoke` and
  `git diff --check` passed.
- The full core unit run had 7,213 passing tests, 20 skips and three failures
  in unrelated PDF/OCR suites under parallel load. All 51 tests in those three
  files passed when rerun separately.
- The root `pnpm test` run stopped at nine desktop keychain tests failing to
  create their fixture command log (`ENOENT`). 23 Turbo tasks succeeded or
  were cached. This is not a fully green repository-wide test run.
- The platform invariant checker still reports workspace-wide stale paths,
  missing KB pairs, existing migration collisions and other findings. It
  reports no migration-hygiene finding for 8152. No baseline was changed.

No follow-up code or migration was deployed by the investigating agent. A new
production trace after operator deployment is needed to measure the actual
end-to-end improvement. The main provider's latency, substantive-turn title
wait, pre-loop failure timing gap and frontend Sharp SIGSEGV remain separate
limitations.
