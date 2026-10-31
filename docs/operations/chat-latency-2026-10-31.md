# Home-server chat latency investigation, 2026-10-31

Read-only production investigation of `awcjack-home-server`, using Brian API,
frontend, PostgreSQL and tunnel journals. Times below are Asia/Hong_Kong.
No production configuration, application files or database rows were changed.

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
