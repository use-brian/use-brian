# Live transcription interaction mode

Status: implemented on the feature branch. Configuration and verification are recorded below.
Base reviewed: origin/develop at feda4ff8.
Branch: feature/live-transcription-interaction.
Worktree: /workspace/brian/use-brian-live-interaction.

## Goal

Add an optional interaction mode to live recording. Keep transcribing the meeting and make that growing transcript searchable immediately. Recognize configurable spoken triggers (default: “Hey Brian”), capture the following question, and prepare an answer in an independent asynchronous job. Several questions must be able to run simultaneously, each grounded in the live transcript and with its own status and result.

## Findings from develop

- `apps/app-web/src/lib/recorder/recorder-engine.ts` maintains durable local capture separately from the provisional live lane. Live transcription currently uses independently decodable **30-second** audio windows. Keep the durable recording lane authoritative.
- `apps/app-web/src/components/chrome/dock-recorder.tsx` exposes the live-page checkbox. `floating-chat.tsx` wires recording through `use-live-recording-page.ts`; that hook streams windows sequentially.
- `packages/api/src/routes/recording-live.ts` handles live start/chunk/windows/link/finalize. A chunk request persists audio, transcribes, persists transcript lines, and then awaits rolling-note revision before responding. Answer generation must not join that inline chain.
- `packages/api/src/db/live-transcript-store.ts` stores provisional windows keyed by chunk/session/workspace/page, with offsets, duration, gap counts and speaker/text lines. It currently offers ordered listing, not live semantic retrieval. Speaker numbers are local to a window; they do not reliably identify the recording user.
- `apps/app-web/src/components/recordings/live-transcript-pane.tsx` merges same-tab events and 10-second polling. It is replaced by the final transcript after processing, so interaction results must not depend on this pane remaining mounted.
- `packages/api/src/recordings/recording-search-tool.ts`, `recording-chat-tools.ts`, and `db/retrieval-store.ts` provide search/range retrieval for processed recordings. Do not assume those indexes contain live windows.
- `packages/core/src/workers/worker.ts` provides parallel restricted query loops, execution context, usage callbacks, and worker persistence hooks. Its lifecycle and notifications are chat-session-oriented, not a stand-alone durable live-question queue.
- `packages/api/src/db/recording-jobs-store.ts` offers a Postgres claim/lease/retry pattern. The existing recording-process worker is single-concurrency: use the pattern, not its heavy final-processing queue, for latency-sensitive live answers.

## Confirmed requirements and proposed operating defaults

1. Interaction is opt-in. Existing recording behavior remains unchanged when disabled. Use real streaming transcription, not timed audio batching; target beginning the response 2–5 seconds after question completion. Full research answers may take longer; measure first answer text separately from progress indicators.
2. Trigger rules are **personal settings expressed in natural language**. Default: “When I say Hey Brian, answer the question that follows.” Snapshot the effective rule/version into the capture session; edits affect subsequent speech only, not a historical replay.
3. **Only the user's microphone input can trigger questions.** Keep microphone provenance before mixing with system playback. Meeting/system audio may supply context but must never be fed to the trigger evaluator as eligible user speech. This is source isolation, not biometric speaker verification; room speech or acoustic speaker bleed picked up by the microphone remains a limitation.
4. Proposed question completion: streaming ASR end-of-utterance/silence detection, with explicit submit/cancel and a bounded timeout. Recognizing a wake phrase opens question capture, but must not submit an empty question. Natural-language rules may also match complete utterances without a wake phrase.
5. Continue listening while answers run. Proposed initial cap: three concurrent answer jobs per capture, with bounded overflow and workspace-wide limits. Queue wait is visible; the latency target must be validated at supported load.
6. Stream text answers **in the existing web/Electron chat window**, not a separate recording answer panel. Persist question/answer message pairs in the originating chat, linked to the recording and timestamped evidence. No TTS or external write actions in v1.
7. Workers can retrieve both current live meeting context and authorized workspace knowledge/past recordings. Reuse existing permitted read-only search tools; public-web tools, if exposed, retain existing policy/availability controls rather than granting new access implicitly.
8. Retrieval tools read **the latest available transcript at call time**, including speech arriving after the question. Keep the question-time cursor as provenance, not a hard cutoff. Return a read revision/cursor with each result and preserve evidence actually used. A worker may fetch newer context again before answering; do not restart or rewrite completed answers automatically whenever new speech arrives.
9. Stopping recording stops new listening after draining accepted audio, but accepted questions finish unless cancelled. Disabling interaction stops new triggers. Access revocation/deletion of the capture or destination chat terminates affected work. Reload restores job status/messages, not browser microphone capture.

## Architecture

```text
Microphone (explicit source identity, before mixing)
  └─ streaming ASR -> personal rule evaluator -> question assembler
                       -> durable question/job queue
                          ├─ worker A -> live + existing retrieval tools
                          ├─ worker B -> live + existing retrieval tools
                          └─ worker C -> live + existing retrieval tools
                               -> persisted messages/events -> existing chat

Microphone + permitted meeting/system sources
  ├─ durable local recording -> existing upload/final processing
  └─ streaming context transcript -> persisted segments + processing events
       ├─ latest-state retrieval + versioned semantic cache
       └─ independent/coalesced rolling notes

Reuse the microphone transcript when mic-only; do not transcribe it twice.
With multiple sources, align timestamps and deduplicate context without
allowing mixed/system transcript text into the microphone trigger lane.
```

### 1. Session, settings, and storage contracts

- Store natural-language interaction rules in authenticated personal preferences, not workspace-wide settings. Add validation, rule versioning and a preview/test surface.
- Add explicit server-owned capture-session metadata: owner, workspace, page, originating chat session, assistant, state, input sources, effective rule/version, and transcript processing cursor. Bind submitted events to that session and check both recording and chat access. Capture source identity is an application routing guarantee, not proof against a malicious client.
- Add durable question/job records: matched rule/version, trigger occurrence, source utterance span, original speech, normalized prompt, evidence references, question-time cursor, execution identity, destination chat/message IDs, status, attempts, lease/fencing token, model, usage, result, error and timestamps.
- Represent transcript evidence using stable window/segment identities plus revision and offset ranges. Current text has window-level timing only; do not fabricate word-accurate timestamps.
- Persist transcript arrival and an outbox/processable cursor atomically. Likewise persist a detected question and enqueue it atomically. A crash between transcript ingestion and detection must not lose a question.
- Use uniqueness on trigger occurrence/session, not prompt text: upload retries should not duplicate a job, but asking the same question later is valid.
- Define access control, retention and cascade deletion for sessions, transcript indexes, questions, results and event logs together.

### 2. Low-latency ingestion and question boundaries

- Confirmed target: begin responding within 2–5 seconds of question completion, without timed batching. The existing 30-second window endpoint cannot meet this requirement.
- First spike: real streaming ASR with partial/final segments and end-of-utterance events. Validate backend/language support, authenticated stream transport, cost, accuracy, reconnect behavior and browser/Electron capture. Short transport frames are fine; accumulating multi-second files before requesting transcription is not the interaction design. If no supported streaming backend is configured, show interaction unavailable rather than silently falling back to 30-second batches.
- Keep the existing durable recorder and normal recording cadence intact. Never shorten/restart the authoritative recording lane to implement wake recognition.
- Partial speech can show “listening”; only stable recognized speech commits a trigger/question. Handle a wake phrase or question split across windows, multiple triggers in one window, duplicate/revised segments, gaps, out-of-order delivery, long pauses and stop during a question.
- Do not reset capture offsets when pausing/resuming. Explicitly mark discontinuities; do not accidentally combine a pre-gap trigger with unrelated later speech.
- Separate rolling-note work from low-latency transcript acknowledgements. Preserve sequential/coalesced notes updates to avoid concurrent page rewrites.
- Extend the capture contract in `apps/app-web/src/lib/recorder/audio-mixer.ts` to expose an explicit microphone tap before mixing. Only this stream's ASR events enter rule evaluation. Keep system/meeting audio in the context lane and keep mic/system identities through reconnection and device changes. Stop/cleanup must not accidentally stop the shared durable recording track.
- Use echo cancellation where available; document that microphone input is not a speaker-authentication mechanism. Test remote playback triggers never fire through the system lane, and characterize acoustic bleed separately.

### 2a. Personal natural-language rule evaluation

- Evaluate stable microphone utterances incrementally against the saved personal rule and a bounded recent mic transcript. Use a low-latency, tool-free model evaluator returning schema-validated decisions: ignore, begin/continue question, submit question, or cancel, with source span and matched rule version.
- The default Hey Brian rule can use a deterministic fast path. Custom rules still require semantic evaluation, not merely conversion to literal aliases. Include evaluation latency/cost in the 2–5 second budget; do not run a full research agent on every partial ASR token.
- Separate the user-authored rule from untrusted recognized speech. The evaluator cannot modify settings, access knowledge tools, send messages, or grant capabilities. Fail closed on malformed/ambiguous decisions; show a recoverable recognition state instead of submitting invented questions.
- Bound evaluator time/tokens and retain pending detection durably. Use utterance/source-span identity for idempotency across ASR revisions and retries. Broad rules may produce many questions, so expose backpressure and a quick disable control.
- Provide rule examples and a text preview showing whether sample speech would trigger and which question would be submitted.

### 3. Live retrieval tools

Proposed tool contracts, named provisionally:

- `searchLiveTranscript(query, filters, limit)`: lexical/hybrid search over the latest authorized capture content at call time.
- `readLiveTranscriptRange(segmentIds | timeRange | afterCursor, surroundingContext)`: exact evidence, neighboring speech, and newly arrived speech, including immediately persisted unindexed content.
- `findSimilarLiveTranscript(query | segmentId, limit)`: semantic similarity with a bounded versioned embedding cache, with fresh-tail coverage/degradation metadata.

Each call returns its read cursor/revision and evidence revisions. An optional as-of cursor supports reproducible reads; latest is the default. Tools are sufficient for ongoing context access: workers need neither an immutable question-time snapshot nor every new utterance pushed into their message history. Give workers a bounded opportunity to refresh after tool work, without waiting indefinitely for a quiet meeting.

All tools are read-only and bound server-side to actor/workspace/capture/page; a model-supplied ID cannot expand that scope. Results include evidence IDs, text, approximate timestamps, provisional status, speaker labels and gaps. Enforce bounded retrieval and context budgets.

Keep lexical/range retrieval available immediately. Embed the current recent tail on demand and reuse version-keyed vectors; expose the exact semantic coverage rather than hiding unindexed speech. This avoids a separate indexing worker/service while meeting the live retrieval requirement. If embeddings fail, report degraded semantic search and continue with lexical/range tools. Knowledge-base/past-recording tools reuse existing authorization and retrieval infrastructure instead of copying workspace data into the live index.

Final transcription may differ from provisional speech. Preserve the evidence used by each answer; map to final segments where possible without silently changing the cited text or re-triggering historical questions.

### 4. Concurrent answer execution

- Implement a dedicated durable queue with bounded parallel consumers, atomic claims, heartbeat leases, bounded retries, cancellation and stale-worker fencing. Reserve separate capacity from final transcription and synthesis.
- Reuse the core restricted worker/query-loop primitives where they fit, but avoid coupling delivery to a later main-chat turn. Each question has its own execution context and persisted result sink. Validate provider adapters for concurrent use; mutable per-run provider state must not be shared.
- “Worker thread” here means an independently scheduled asynchronous answer run. Model/retrieval work is I/O-bound, so OS/Node worker threads are not necessary for concurrency. Use separate worker processes/services for scheduling and durability; reserve threads for any genuinely CPU-bound work.
- Give every job recent transcript evidence, the question and approved retrieval tools. Recheck permissions when executing and retrieving. Meeting text is evidence, not authority to expand tool permissions.
- Do not use a shared chat turn lock or shared conversation buffer for all questions. Do not reset a global worker manager in a way that cancels another question/session.
- Enforce per-capture/workspace concurrency, queue length, model-turn/token budgets and timeouts. Record metering and correlation IDs without logging raw meeting speech by default.
- Persist status and final answer independently of browser connections. Prefer an existing authorized event transport with reconnect support; retain cursor/status reads as recovery fallback.
- Chat is the presentation/delivery destination, not a single execution lock. Allocate stable question, run and message IDs before streaming. Route every delta/status event by those IDs so concurrent answers cannot interleave into one assistant bubble. Bind the destination chat at capture start; navigating to another chat must not redirect running answers or expose them there.
- Integrate with canonical message persistence and event replay rather than appending transient local-only bubbles. Ordinary typed chat can continue while voice answer jobs run. Preserve causal pairing when answers finish out of order, and verify any existing chat prompt assembly does not mix unfinished runs.

### 5. UI and settings

- Add an Interaction option alongside live transcription in `dock-recorder.tsx`, wired through the recorder controller and `use-live-recording-page.ts`. Show unavailable/disabled states clearly.
- Add personal Recording/Interaction preferences in the settings modal: a natural-language rule editor with default/example rules and preview. Clearly state that only microphone input triggers, while authorized meeting/context sources can inform answers.
- Extend the existing chat UI (`floating-chat.tsx` and shared message components/store) with source-linked recognized question messages and independent answer streams/statuses. Support cancel/retry and question correction. Do not implement a separate recording answer panel or reuse a single mutable streaming-text buffer for every job.
- Show listening/question-capture state and recording link in chat. Keep answers accessible in chat after final transcription replaces the live pane; evidence links navigate back to the recording.
- Ensure typed chat, transcript scrolling and ongoing recording stay responsive while several answers stream. Keep results anchored to their questions even when completion order differs; reopening the originating chat restores messages and in-flight state.
- Follow app-web responsive/navigation contracts, existing controls, and all four translation dictionaries. Initial scope is web and Electron; other native clients are out of scope.

## Delivery sequence

1. Spike streaming ASR and microphone isolation on web/Electron; benchmark end-of-utterance and natural-rule evaluation latency. Choose a supported streaming provider/transport from measured results.
2. Add shared contracts, personal preferences, capture/chat bindings, access checks, transcript identity and durable event/job storage.
3. Implement latest-state live retrieval, bounded semantic caching, evidence citations and fresh-tail fallback; expose existing authorized knowledge tools.
4. Implement semantic personal-rule evaluation, question assembly and idempotent durable enqueue, with a deterministic default-rule fast path. Keep it behind a feature flag.
5. Implement bounded concurrent answer consumers with read-only tools, metering, cancellation, recovery and per-question message/event transport.
6. Implement recording toggle, personal rule settings and concurrent answers in the existing chat; retain normal live-transcription behavior when disabled.
7. Integration/security/load testing, measured latency/cost rollout, documentation and feature-flagged release.

## Verification / acceptance

- Two or more questions overlap in execution while capture/transcription continue; each receives the correct isolated context and result.
- A question can retrieve earlier meeting speech, authorized workspace knowledge and speech arriving after enqueue without waiting for final processing or embedding completion. Results cite the exact evidence versions used.
- Personal natural-language rules work beyond literal wake phrases; settings do not leak between users. Default phrase variants, split utterances, silence, empty triggers, gaps and ASR revisions behave predictably.
- System/mixed transcript events cannot trigger questions. Microphone provenance survives device changes/reconnects; unsupported configurations fail visibly rather than falling back to mixed-audio detection.
- Two voice answers stream into separate chat messages while a typed turn is active. Switching chats, replay/reconnect and out-of-order completion never redirect or merge answers.
- Duplicate upload/events do not produce duplicate questions. Intentional repeated questions remain separate occurrences.
- Process crashes, reconnects, expired leases and retries recover jobs without duplicate published answers; stale workers cannot overwrite cancellation/completion.
- Tests prove no cross-workspace/page/session leakage, including changed permissions, guessed IDs, malicious transcript instructions and injected tool scope.
- Stopping/disabling recording, closing the UI, deleting a page and replacing the live transcript with the final transcript follow the stated lifecycle.
- Provider/index/notes outages degrade independently; durable recording remains intact and the UI exposes missed/unavailable context.
- Benchmark end-of-speech -> recognized question, rule evaluation, queue wait, first answer token and full answer under concurrency against the confirmed 2–5 second first-response target. Progress indicators are not counted as answer tokens. Also track capture gaps, cost, index lag and accidental triggers.
- Extend recording-live route and live-pane/recorder tests; add focused trigger, retrieval, queue/lease, permission and end-to-end tests. Focused regressions and full web/core/desktop suites have been run; see verification below.

## Confirmation and remaining engineering choices

User confirmed: 2–5 second latency without batching; personal natural-language rules; microphone-only triggers; live and broader context with access to later speech through tools; text delivery in the existing web/Electron chat window.

Implementation choices:

- OpenAI Realtime transcription over WebRTC, with `gpt-4o-transcribe` and server VAD (500 ms silence). Browser credentials expire after 60 seconds; the server key never leaves the API. No timed audio-file batches feed interaction detection.
- Use the configured background model for semantic rules and answers. The default Hey Brian rule has a deterministic fast path. Private retrieval is one bounded model round, followed by a tool-free answer stream; tool-planning text is never published.
- Three concurrent answers per capture, twelve per workspace/process, bounded workspace admission, three attempts for processing/publication/detection, and fencing on cancellation/expired claims. Authenticated token/start/preview routes have per-user limits.
- Canonical personal web chat messages are published transactionally and idempotently after completion. Active jobs are independently polled every 1.5 seconds. Canonical refresh appends only the job's own pair, never replacing a typed turn. Exact evidence and scope labels persist before any partial answer is exposed; permission checks apply to polling as well as publication.
- Streaming microphone/system finals feed the existing live transcript pane immediately in the recording tab and through the persisted read for other tabs. Existing 30-second audio windows remain only for recovery storage and coalesced notes while interaction is active, without a second ASR call.
- Live range and lexical reads are immediate. Semantic search embeds a bounded recent set on demand with a versioned cache and explicit coverage/fallback metadata, rather than adding a separate vector-index service. Older evidence remains range/keyword searchable. This keeps the interaction implementation bounded and reuses existing workspace retrieval for broader context.

Scope interpretation: broader context means authorized workspace knowledge/past recordings and existing permitted search tools; it does not grant new external-source access. Completed answers remain stable unless explicitly retried/followed up. Silence-based completion includes Ask now, cancel pending, and edit/resubmit controls.

## Configuration and operational limits

- Apply migration `653_live_interaction.sql` and set server-only `LIVE_INTERACTION_OPENAI_API_KEY` to enable streaming transcription. Normal recording continues without this key; the interaction option explains its unavailable state. API worker processes must run the existing `runWorkers` composition.
- Enable Interaction in the recorder menu. This enables the live page and binds answers to the current personal chat, in either the main chat or the floating dock. Interaction keeps that chat open instead of navigating to the recording page. The server derives the answering assistant from the destination chat, not the dock's selected assistant. Feed/shared-room recorder targets are explicitly unavailable rather than silently routing answers to another thread. Settings > General contains the personal natural-language rule editor and preview.
- Microphone-only is a source boundary, not voice authentication. Echo cancellation mitigates but cannot guarantee suppression of room speech/acoustic playback picked up by the microphone.
- Transcript and question data cascade with their capture page, owning chat, user or workspace. Answer evidence is retained with the job and canonical trace; final transcription does not re-trigger old utterances or silently rewrite prior evidence.
- The 2–5 second first-response target is provider/network/load dependent, not a hard SLA. Automated tests verify immediate ASR-final ingestion and early answer delivery without waiting for stream completion. Real microphone/Electron/provider latency qualification requires a configured Realtime credential and those runtimes; no real-provider benchmark is claimed from this headless environment.

## Verification

- API and app-web TypeScript checks pass.
- Focused API tests: 91 passed across seven files. They cover real migration/store SQL under PGlite, queue admission/claims/recovery, permission revocation, durable evidence, token protocol, source isolation, multiple/split wake questions, semantic rules, streamed composition, and canonical publication.
- Full app-web suite: 663 files, 5,777 tests passed (one skipped), with two workers. A concurrent API/web run hit two unrelated office test timeouts; all 27 office tests passed independently, and the complete bounded web rerun passed. Main-chat tests cover two canonical voice answers during a typed stream, session isolation, and no navigation during interaction startup.
- Bounded root suite completed core (6,352 tests passed), desktop (698 passed), and shared (433 passed), among other packages. The root run was stopped after ten minutes with workflow-store/workflows-route failures in the broader API suite; all three failures were reproduced in a clean detached worktree at base `feda4ff8`. The root suite is not reported as green. The initial default-concurrency run hit desktop release-test timeouts; those 26 tests passed separately with bounded workers and a 30-second test budget.
- `pnpm smoke` passes. This OSS repository has no `pnpm check` script; API/app-web typechecks, focused tests and `git diff --check` are used instead. No unrelated workflow tests or global test baselines were changed.
