# Brian engineering capture

`brian-capture` observes explicitly opted-in Codex or Claude Code hooks and delivers selected prompts and final user-facing replies through Brain MCP. Brian owns purpose, profile and audience. This collector does not run a model, control coding, create operational memories/tasks or install hooks.

Requires Node 22.13 or newer and a Brian endpoint with version-1 `getCaptureConfiguration` and structured archive receipts. Select an enabled engineering archive profile and its Project/Department audience in Brian first. New keys and ordinary extraction profiles do not opt in.

## Inspect setup

```sh
brian-capture setup --provider codex --project /workspace/example-project \
  --endpoint https://brain.example/api/brain/mcp --credential-env BRAIN_CAPTURE_KEY
```

Use `--provider claude-code` for Claude Code. An explicit `--session` can constrain a session instead of, or alongside, the project path. The result is an inspectable configuration and merge plan. Save configuration outside repositories, then pass its absolute path with `--config`. `--existing-hooks /outside-repository/hooks.json` merges only collector entries into an inspected copy, preserving unrelated settings. Setup writes no provider settings or credentials. Review/trust hooks through the provider's normal flow; never bypass hook trust. Destination and permissions are configured in Brian, not in this file.

Hooks return `{}` and exit successfully, including when capture fails. They enqueue durably, then wake a detached transport worker. One SQLite lease owns delivery across concurrent hooks; SessionStart/resume also wakes it. No approval, continuation, permission decision or additional model context is returned. No real work machine or key is configured by this package's tests/build.

```sh
brian-capture status --config /outside-repository/capture.json
brian-capture flush --config /outside-repository/capture.json
brian-capture worker --config /outside-repository/capture.json
```

The hook and worker commands are emitted in the setup plan. `flush --resume` explicitly retries suspended WIP with the same connection. After inspecting a deliberate server configuration change, `flush --resume --accept-configuration` accepts its new fingerprint. This never substitutes credentials or changes a Brian destination. Move WIP to another credential/destination only through a separately reviewed recovery process.

## Storage, identity and bounds

The default spool is `~/.usebrian/engineering-capture/spool.sqlite`, outside repositories. Its directory is owner-only (0700), its files are owner-only (0600), and SQLite uses WAL with full synchronous durability and secure deletion. The spool stores only selected text and minimal observed provenance; credentials are resolved from the named environment variable at runtime and never stored or printed. Repository-local/symlinked spool targets are refused. A canonical original remains in Brian Files after a typed archived receipt; local terminal delivery records retain metadata instead of selected text.

Defaults: 256 KiB selected text per event, 1,000 outstanding events, 64 MiB pending bytes, 12 failed delivery attempts, 1 second exponential backoff capped at 5 minutes, a 30 second worker lease and a 10 second MCP request timeout. Queue/payload bounds are configurable within the schema's documented maxima. Limits and permanent denials are visible failures; pending bytes remain available for review. A transport worker exits after an hour without successful delivery and is woken by subsequent hooks. These bounds buy no model processing and renew no work budgets.

MCP negotiation and invocation use the official SDK's Streamable HTTP client. Configuration is checked before replay. The connection/profile/revision/audience fingerprint prevents silent reconfiguration. An endpoint without the typed archive contract is refused. Queued/duplicate-pending acknowledgement is retained and polled for actual archive delivery; it is not counted as archived. Authentication, configuration and source denial suspend; transient storage/network/uncertain-ack failures retain identity for bounded retry.

`status` distinguishes emitted, pending, archived-at-receipt, excluded, failed and unobserved/unsupported observations, last contact and last delivery. It contains no source text or key values. Local hook observation and Brian delivery/index state are separate. No observed capture is not evidence that no engineering work happened. Stored receipts describe their observation time, not a guarantee of continued server retention or access.

## Provider coverage

Adapters use the documented selected `UserPromptSubmit.prompt` and `Stop.last_assistant_message` fields, plus session and (for Codex) available turn identity. They never open `transcript_path`, read attachment bytes or forward system/tool/reasoning/subagent fields. Missing final output, interrupted turns and unknown schemas are diagnostics. Every submitted author/result claim remains unverified; an automated submission is not human approval, steering, renewed allowance or benchmark ground truth.

Codex's documented turn id supplies source replay identity when available. Without a documented immutable identity, each source submission receives its own durable local id/ordinal. Transport retries reuse it; replay of a provider notification without an immutable identity cannot be distinguished from a legitimate repeated submission. Identical text alone never deduplicates work.

Compatibility is checked against the documented v1 field shape, not inferred from a model's behavior. Official references: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude Code hooks](https://code.claude.com/docs/en/hooks). Installed desktop/CLI versions, hook trust, interruptions, offline continuity and privacy behavior require live acceptance on each opted-in machine. Package publication, real installation, production rollout and any retention/backfill policy remain owed operations. Offline goal setting and benchmark construction/runs are outside this package.
