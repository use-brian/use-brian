# Foreground classifiers and Standard split preparation

Classifier failures are not evidence of an empty main assistant generation.
The correlated response diagnostics distinguish these calls. In particular, the
historical clean Codex `end_turn` with no public text remains unexplained until
it reproduces with diagnostics; this change does not claim to fix that case.

## Strict decision schemas

The common LLM decision adapter emits closed objects with every property in
`required`. Confidence is required but nullable; boolean answers additionally
have required nullable `pTrue`. Null means unavailable, never a fabricated
confidence or probability. Choice and score answers do not request `pTrue`.
Existing value validation, typed decoding, question ordering and decision
profiles remain authoritative.

Identical ordered choice domains share deterministic local leaf `$defs`/`$ref`
entries. Seven combined intent/tool-ranking questions over 357 tools previously
repeated 1,082 enum values; the wire schema now contains 364 without removing or
reordering choices. OpenAI/Codex target admission checks enum, string-vocabulary
and property budgets before dispatch, including known models behind the routing
provider. Other providers do not inherit these target-specific caps. Cyclic
state is rejected before serialization.

Existing decision-model thinking defaults and answer-token budgets are
unchanged, including Gemini's low reasoning and shared-token accommodation.
The registry's general thinking capability is not treated as proof that every
native model supports a particular reasoning-effort setting.

An offline integration test uses the pinned Codex runtime, production inference
hardening, isolated temporary home/cwd, no credentials and a loopback fake
Responses API enforcing strict schema requirements. It verifies the **source**
adapter's actual wire request, not a repaired or stale compiled schema. It does
not establish that a historical live failure had this exact upstream rejection.

## Topic deadline

The default generation budget remains 2 seconds. Known Codex routes receive an
8-second generation budget, including registry-resolved models behind the
routing provider. The known Standard OpenAI-compatible background fallback also
receives this bound. Unknown/custom routing entries remain conservative. A host absolute
`deadlineAt` can only narrow this budget; caller, lifecycle and decision-profile
limits still apply. Low topic reasoning, sticky source refusal, fresh final
validation and fallback behavior remain intact.

These are generation deadlines, not permission-proof timeouts. Returning a
fallback must still join pending authority checks and validate current access.
A stalled authority proof can therefore extend total wall time beyond the
model-generation deadline. Timeout never manufactures permission.

## Parallel preparation, not early worker execution

Only an invariant Standard legacy preflight route may prepare its splitter
classification alongside research and topic assessment. Eligibility requires a
primary non-doc surface, no explicit research/site mode, a sufficiently long
message, no custom or active metered model selection, and Standard resolution
under both ordinary and downgraded budget states. Other routes retain their
late canonical classifier. `research: false` is **not** interpreted as no split.

The splitter reads the same admitted authored message and complete source
cohort, with a separate accumulator and privately bound authority. Mixed or
transformed input stays on the late path. The legacy provider/default-model
route is preserved: no decision-runtime override is introduced into Standard
preflight. Its generation is cancellable and bounded to 8 seconds. A positive
research/site assessment cancels unnecessary speculative classification.

Every sibling settles before admission continues or fails, and accumulated
source evidence is merged. Successful preparation usage is recorded once even
when another assessment refuses or a later research/budget verdict discards it.
No completed result is charged again on reuse. Interrupted calls without a
completed result do not fabricate usage.

Preparation contains data, not a permission receipt. At the original preflight
boundary, exact message bytes and provider identity must match. Consumption is
one-shot and requires a new current source proof, captured root/fork identity
checks and cancellation checks. Worker spawning, plan seeding, events and other
preflight effects remain at the original late boundary. Fresh Memory retrieval,
per-event/final output authority and publication checks are unchanged.

Overlap removes an avoidable serial classification window; it does not promise
production latency percentiles or equate native wait with pure inference time.
