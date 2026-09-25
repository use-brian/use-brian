# Temporary document extraction diagnostics

Set `BRIAN_DEBUG_DOCUMENT_FLOW=1` on the **API server process** and restart it.
Unset it (or use `0`) and restart to disable; it is off by default. No UI setting
or client-side environment variable is needed. Reproduce separate OCR, separate
PDF/direct-model, then combined extraction using the same model.

Filter server stdout for **`[document-flow-debug]`**. Share only those lines for
the reproduction, plus which attempt was separate/combined and the time window.
Do not share the surrounding server logs, turn-ledger payloads, uploaded files,
API keys, request bodies, or tool output. Disable this temporary diagnostic after
capture. Counts, model choices and usage can still be operationally sensitive.

Each line contains bounded structured metadata, never source text, filenames,
URLs, base64, tool arguments, credentials or error messages. `session` is the
first 16 hex characters of SHA-256 of the existing session ID; it correlates chat,
loop, tools and adapter without logging caller-supplied identifiers. Model names
are restricted to registry aliases; custom/unknown models say `other`. Tool-name
counts use a small literal host-tool allowlist; all other names count as `other`.
MIME buckets are PDF (`application/pdf`), JPEG, PNG and other. Lengths are JS
string character counts, **not** decoded bytes or token estimates.

Events:
- `chat_input`: blocks immediately after attachment construction (requested model).
- `tool_availability`: `before_filter` and `after_filter` at the loop capability/
  visibility gate. `declarations.total` counts all declarations; `presence` always
  has seven boolean keys: `listDocumentExtractionConnectors`,
  `prepareDocumentExtraction`, `startDocumentExtraction`, `readDocumentExtraction`,
  `proposeOfficeEvidenceFill`, `mcp_search`, `mcp_call`. No arbitrary names are
  emitted. A true→false change identifies filtering, not MCP discovery failure.
- `gemini_wire`: immediately before each actual Gemini fetch (including schema
  retries), after request assembly, for both stateful and stateless paths.
  `gemini.inline` counts serialized function declarations with the same seven
  booleans. `toolChoiceMode` reports the outbound mode (`AUTO`, `NONE`, `ANY`,
  etc.); `omitted` means no explicit mode, **not** `NONE`. Declaration presence
  does not mean callable when choice is `NONE`.
  `cached` indicates an explicit cache reference; `declarationSource` distinguishes
  inline/cached/both. `effectiveKnown` and `effective` describe known effective
  declarations; an unknown referenced cache yields `false`/`null`, never false
  absence. The current adapter has no explicit cache creation/reference path:
  tools remain inline on both paths, including implicit server-side cache hits.
  Cache usage tokens do not imply omitted declarations. No cache IDs are logged.
  The current provider API has no tool-choice override: declared tools serialize
  as `AUTO`; a tool-less request omits both declarations and mode. This diagnostic
  does not add or change tool-choice behavior.
- `request`: each loop call. `stateful_delta` is **only new engine messages**, NOT
  the complete provider history: no PDF in a later delta does not prove omission.
  `stateless_full` is the full engine history supplied on that call.
- `document_adaptation` / `context_fit`: before/after counts at media adaptation
  and budget trimming. Reactive loop compaction emits `compaction`.
- `openai_wire`: actual OpenAI-compatible serialized-message shapes immediately
  before fetch, including retained stateful history. Compare engine `summary`
  PDF/media counts with `wire` image-url, text-character and tool-message counts.
  This adapter currently replaces non-image inline media (including PDFs) with
  a text note; upstream document adaptation may already have distilled it.
  This event does not claim that the endpoint internally accepted/read the PDF.
- `codex_turn_wire` / `codex_history_wire` / `codex_tool_wire`: actual Codex
  app-server `turn/start` input, injected history, and parked-tool reply content.
  **Registry GPT-5.6 Sol/Terra currently use this adapter.** Compare engine
  `summary.pdf` with `codex.pdfDataUrls` and text/image counts. PDF is not a native
  Codex input here: upstream distillation or the adapter's unreadable-media note
  replaces it. After a tool call, `codex_tool_wire` is only the reply delta on the
  same remote turn, not the remote thread's full retained context. Absence of a
  PDF in that delta is not evidence that earlier context was dropped. History
  and turn counts are post-serialization/capping; tool replies flag truncation.
- `response`: provider stop reason, text characters, tool-use counts and usage,
  before loop recovery/sanitization; max-token/incomplete stops flag truncation.
- `tool_completion`: executor outcome, pre/post-cap sizes and truncation/timeout
  flags. `tool_result` separately summarizes blocks delivered to the loop,
  including early rejection results. Do not sum these as independent executions.
- `stream_error`: error/abort/timeout indicators, no error details. Timeout is
  affirmative only where the host timer/watchdog observed it; false does not rule
  out a remote timeout or a tool-reported timeout encoded only in its content.

Existing turn-ledger and verbose provider tracing are unchanged. This diagnostic
is deliberately not a second payload recorder. Events outside a query-loop scope
may lack session correlation. A stream failing before completion has no completed
`response` record; use its `stream_error` event instead. Final wire inspection is
implemented for OpenAI-compatible Chat Completions, Gemini tool metadata, and the Codex app-server,
not every provider protocol. It cannot inspect context retained inside the remote
Codex thread. No raw RPC thread/turn IDs are logged.

For an empty-response reproduction, correlate `session`, compare availability
before/after filtering, then inspect **each** `gemini_wire` followed by `response`.
This distinguishes missing registration, filtering, outbound declaration omission,
and tool-choice disabling from a model simply returning no tool call. MCP discovery
alone does not establish native extraction-tool availability. `gemini_wire` does
not claim that the remote model accepted or used any declared tool.

### Safe provider error classification

`stream_error` now adds `category` (fixed enum) and `httpStatus` (validated number
or `null`). The query-loop record classifies the caught error, including bounded
network causes. Gemini also records rejected HTTP requests, missing response
bodies, and missing finish reasons at the provider boundary. These detailed
records still require `BRIAN_DEBUG_DOCUMENT_FLOW=1`. The normal
`[chat] query loop failed` summary includes only `category`/`httpStatus` alongside
its existing session ID, not exception text.

For the next failed turn, correlate hashed `session`, `model`, and `turn` on
`stream_error` with the preceding `gemini_wire`/`request` records. Categories are
`invalid_argument`, `signature_error`, `tool_pairing_error`, `rate_limit`, `auth`,
`upstream_failure`, `network`, `aborted`, `idle_timeout`, `incomplete_stream`, or
`unknown`. A 400 alone is **not** proof of invalid arguments, signatures, or tool
pairing: specific categories require recognizable Gemini JSON validation fields.
Only the anchored `Gemini API error NNN: ` envelope is parsed; JSON inspection is
bounded to 16 KiB and no body, message, credential, field path, or cause text is
emitted. Missing/unrecognized evidence remains `unknown`/`null`; these heuristics
are diagnostics, not retry decisions. Existing timeout/abort booleans describe
local observations, not proof that the provider ruled those causes out.
