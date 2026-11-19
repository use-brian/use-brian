/**
 * @use-brian/agent-runtime: the provider-neutral agent runtime.
 *
 * SKELETON (M4 step 1, docs/plans/oss-chat-m4-runtime-separation-plan.md
 * section 2). This module is intentionally empty. What moves in, from
 * `packages/core/src/`, in steps 2 and 3 (type-inclusive closure of 94 files,
 * proven by `scripts/testing/import-graph.mjs --closure` before any move):
 *
 *   engine/      query-loop, turn-output, tool-executor, stall-watchdog,
 *                turn-ledger, loop-detector, tool-pairing, output-provenance,
 *                hooks, turn-inbox, tool-discovery, document-flow-debug,
 *                grounding-gate
 *   providers/   all provider adapters, including codex-app-server/*
 *   tools/       types, capability-gate, tool-failure, schema-tolerance,
 *                base/ask-question (schema)
 *   context/     security/{sanitize, sensitivity, derived-scope, compartments,
 *                context-scope, evidence, source-evidence, authority-source,
 *                access-context, access-ceiling, execution-context,
 *                department-read, workspace-delegation}
 *   compaction/  compact, cache-tool, index
 *   billing/     cost-tracker
 *   protocol/    mcp/{types, classifier, input-schema}, QueryEvent and
 *                StreamChunk types, later a pure SSE frame encoder
 *
 * Product domains (Office, CRM, campaigns, ingest, sandbox, documents, views)
 * never move here and are never imported from here. The kernel, admission,
 * conversation store, MCP catalog and composition stay in `@use-brian/api`.
 * Consumers import file-level subpaths (`@use-brian/agent-runtime/<path>.js`);
 * a small `"."` for the engine contract may be added later, never a barrel of
 * provider adapters. Old core paths keep forwarding shims until step 7.
 */
export {}
