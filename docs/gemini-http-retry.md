# Gemini HTTP 429 retries

AI Studio and Vertex (including Vertex global) retry only rejected HTTP 429 responses, before successful SSE parsing. Each retry sends the identical serialized body; no engine turn or tool execution is replayed. Endpoints, locations, credentials and routing are unchanged. Network errors, other HTTP statuses, and failures after a successful response are not retried by this helper.

The limit is **three retries** (four HTTP attempts) and a **60-second admission budget starting at the first 429**, including rejected-body inspection, subsequent HTTP requests and waits. No 60-second limit is imposed before the first 429 or on successful SSE consumption. The existing 400 schema fallback shares the count/deadline but still deliberately removes the rejected schema.

Without valid server hints, waits are **5, 10, 20 seconds plus independent 0–2 second additive jitter** each: 35–41 seconds total sleep. Retry-After seconds/HTTP-date and Google RPC RetryInfo protobuf JSON duration strings take precedence; when both exist the longer delay wins. Hints are minimum waits, never shortened by jitter or to fit a budget. A wait at or beyond the remaining admission deadline fails immediately. Known daily/zero quotas and disabled billing stop immediately; generic RESOURCE_EXHAUSTED is not definitive hard quota.

## Timeout coordination

`wrapIdleTimeout` passes an internal mutable deadline/rate-limit marker through `ProviderRequest` and session `SendOptions`. Gemini constrains admission to the earlier of the retry deadline and the wrapper's remaining window. The default 90-second first-deliverable and 30-second subsequent idle windows are **not extended**. For example, a first 429 at 85 seconds cannot schedule a 7-second fallback wait. If a retry is still pending when the wrapper expires, it aborts the underlying Gemini request and reports a fixed 429 admission error, not `Stream idle`. The query-loop transient classifier does not replay these 429 errors. Once real deliverable content arrives, normal idle classification resumes. Existing synthetic start/reasoning chunk timing semantics are unchanged.

This is deadline plumbing, not fake progress: no text, thinking, tool, or status chunks are manufactured. Session sends forward the wrapper's cancellation signal; disconnects and deadline expiration cancel fetch/sleep. Wrapper cleanup also aborts pending work and handles asynchronous iterator cleanup failures.

Rejected bodies are inspected only up to 32 KiB and one second, then canceled best-effort without waiting for stalled cancellation. Malformed bodies fall back to backoff. Cancellation interrupts sleep and is checked before every fetch. Final 429 errors contain fixed messages, never raw responses.

## Opt-in diagnostics

Set `BRIAN_DEBUG_GEMINI_HTTP_RETRY=1` for `[gemini-http-retry]` JSON metadata. Fields: fixed category; transport (`vertex`, `ai-studio`, `unknown`); registry-allowlisted model (otherwise `other`); quota classification (`capacity`, `requests`, `tokens`, `daily`, `billing`, `unknown`); hint source (`retry_after`, `retry_info`, `both`, `fallback`); reason (`scheduled`, `admitted`, `hard_quota`, `retry_limit`, `delay_exceeds_deadline`, `deadline`, `canceled`, `request_failed`); retry attempt count, delay and remaining milliseconds. `admitted` means a non-429 HTTP response, not necessarily success. Classification is best-effort, not a quota diagnosis. No raw errors, identifiers, URLs, secrets, quota names or content are logged. This flag is independent of document-flow diagnostics.

Concurrent requests remain independent: jitter reduces synchronization but does not provide shared admission control or a distributed quota scheduler. No suitable shared transport admission mechanism was found; fleet-wide coordination is outside this change. UI retry status is also outside this change.
