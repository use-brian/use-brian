# Live transcription interaction mode

Status: implemented on `feature/live-transcription-interaction`, PR #398 against `develop`.

## Current requirements

Interaction is opt-in for web and Electron. Personal natural-language rules recognize spoken questions (default: “Hey Brian”). Each question gets an independent asynchronous answer job that can retrieve the growing meeting transcript and authorized workspace knowledge, including speech arriving after the question. Answers stream into the originating personal chat while recording and ordinary typed chat continue.

**User-confirmed revision:** reuse Brian's existing live transcription pipeline, rather than introducing OpenAI Realtime. This supersedes the earlier no-batching and 2–5-second requirements. Questions wait for the existing **30-second transcript windows**, plus transcription, queue and answer latency. No separate transcription provider, OpenAI access or interaction-specific API key is required.

## Capture and transcription

- Keep the existing durable recorder, upload/recovery storage, live transcript pane, rolling notes and final recording processing.
- Interaction uses the existing `/api/recordings/live/chunk` endpoint and configured `voiceTranscription` backend/model. The background model evaluates custom rules and answers questions.
- For microphone-only captures, transcribe the normal live audio window once. Reuse that exact transcript for both the live page and interaction ingestion.
- For mixed microphone/computer-audio captures, the normal mixed window supplies meeting context but **cannot trigger questions**. Encode an isolated pre-mix microphone window at the same cadence and transcribe it through the same configured backend for triggers. This incurs an additional transcription call for each mixed interaction window, but no duplicate ASR for mic-only captures.
- The multipart contract is `audio`, optional isolated `microphone`, `interactionCaptureId`, `interactionSource` (`microphone` or `mixed`), and optional `discontinuity`. Missing/failed isolated microphone audio never falls back to detecting triggers in mixed playback.
- Only server-generated transcription enters the durable interaction inbox. There are no browser transcript-ingestion or Realtime token endpoints.
- Pause/resume and missing windows break pending question assembly. Failed interaction ingestion leaves a visible gap and preserves the normal audio/transcript path.
- Stop flushes local encoders immediately; server interaction stop waits for accepted live-window uploads to drain in the background. A newer recording cannot overwrite an older recording's capture binding. Disabling interaction stops future triggers without stopping normal recording/transcription.
- Input-source isolation is not biometric speaker authentication. Room speech or acoustic playback picked up by the microphone remains eligible microphone input. Echo cancellation is not a guarantee against acoustic bleed.

## Settings, durable processing and answers

- Personal rules have versions; changes apply to subsequent speech, not historical replay. Settings include a natural-language editor and text preview.
- The default rule has a deterministic “Hey Brian” fast path; custom rules use a bounded, tool-free semantic evaluator with schema-validated decisions.
- Captures bind owner, workspace, page, destination chat and assistant server-side. The answering assistant comes from the destination chat, not the dock's independently selected assistant.
- Transcript source IDs are stable per capture/window/source. Ingestion is idempotent and occurs before the canonical live-window duplicate boundary, so a crash before window persistence can retry without duplicating questions.
- Durable inbox processing and question enqueue use leases, retry bounds and fencing. Intentional repeated questions in different windows remain separate occurrences.
- Answer jobs run independently: three concurrent jobs per capture, bounded workspace admission and up to twelve active jobs per worker process. They do not take the ordinary typed-chat turn lock.
- Each job uses bounded private retrieval followed by a tool-free answer stream. Planning/tool narration is not published. Usage is metered through existing infrastructure.
- Live range, keyword and semantic tools read the latest persisted transcript at call time, not a question-time snapshot. Range/keyword reads cover older windows; a bounded versioned embedding cache supports recent semantic search with explicit coverage and lexical fallback.
- Existing read-only workspace knowledge/past-recording tools retain their authorization. Meeting speech is evidence, never authority to expand permissions or invoke writes.
- Evidence and scope labels persist before partial answers are exposed. Polling, retrieval and canonical publication recheck access. Exact evidence survives final transcription revisions; old speech is never re-triggered and completed answers are not silently rewritten.
- Canonical question/answer pairs publish transactionally and idempotently. Stable per-job identity prevents duplicate answers and interleaving between concurrent questions. Cancellation, retry and edit/resubmit remain available.

## Chat and lifecycle

- Main chat and floating dock show separate answer cards and canonical chat messages. Refresh appends only the job's pair and never replaces a typed streaming buffer.
- Interaction startup keeps the originating chat open rather than navigating to the live page. Switching chats cannot redirect jobs or expose another chat's answers/controls.
- Feed/shared-room destinations are explicitly unavailable; supported destinations are personal web/Electron chats.
- Accepted questions finish after recording stops unless cancelled. Reload restores jobs/messages, not microphone capture.
- Capture data cascades with its page, chat, owner or workspace. Answers remain in canonical chat independently of the provisional transcript pane.

## Configuration

1. Apply migration `655_live_interaction.sql`.
2. Enable/configure Brian's existing voice/live transcription (`VOICE_TRANSCRIPTION_ENABLED` and the deployment's existing media backend/model credentials).
3. Run the existing API worker composition (`runWorkers`) and enable Interaction in the recorder menu.
4. Configure personal rules under Settings > General.

`LIVE_INTERACTION_OPENAI_API_KEY` is removed and no longer used. There is no WebRTC/Realtime transcription connection or separate transcription-provider setup for interaction. Normal live recording remains unchanged when Interaction is disabled.

## Verification

Focused tests cover:

- One ASR call for mic-only captures; the same configured transcriber and correct usage metering for mixed/context and isolated microphone windows.
- Playback cannot trigger questions; missing/failed microphone audio fails closed. Pause boundaries and gaps cannot join unrelated speech.
- Real migration/store SQL under PGlite: idempotent enqueue, concurrent claims, leases, cancellation, recovery and permission checks.
- Concurrent answers, latest-state retrieval, evidence preservation and canonical publication.
- Shared recorder timing, isolated microphone encoder cleanup, ordinary recording continuity, final-upload draining, and independent old/new capture bindings.
- Main-chat/dock routing, typed-stream preservation, settings/preview, and all four translation dictionaries.

Reuse-pipeline verification: API/app-web typechecks and 103 focused API tests passed. The full web run passed 5,770 tests with one skipped, but hit 18 timeout/cascading failures in the unchanged drawing-library and office suites while API tests were running concurrently. All 43 tests in those two suites passed on an isolated single-worker rerun; no unrelated test code or timeouts were changed. Focused recorder/UI checks also passed. Real microphone/device/provider qualification still requires the deployed browser/Electron runtimes; no 2–5-second response or real-provider latency benchmark is claimed.
