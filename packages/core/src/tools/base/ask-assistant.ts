/**
 * Inter-assistant communication tools.
 *
 * Built-in tools for querying connected assistants. Connections are
 * workspace-internal (auto-seeded primary → sibling edges); the wire format
 * is A2A (`ConsultTransport.send()`), and the destination's `runConsult`
 * handles query-loop execution. The destination-side mode/approval policy
 * layer was retired 2026-07-24 — same-workspace consults run with full
 * workspace trust. See:
 * - docs/architecture/integrations/a2a.md
 * - docs/architecture/channels/inter-assistant.md
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import { INITIAL_BUDGET, type ConsultRequest, type ConsultTransport } from '../../a2a/index.js'

// ── Dependency types ───────────────────────────────────────────

export type InterAssistantDeps = {
  /** Check if caller follows callee (accepted status). */
  isFollowing: (followerAssistantId: string, followingAssistantId: string) => Promise<boolean>

  /** List assistants I follow (accepted). */
  getFollowing: (assistantId: string) => Promise<Array<{
    followingAssistantId: string
    /** The assistant's workspaceId — needed for ConsultRequest.target.workspaceId. */
    followingWorkspaceId: string
    followingAssistantName?: string
    followingOwnerHandle?: string
    /** Owner-set short description of what the callee assistant is for (max 200 chars). */
    followingBio?: string | null
    /**
     * How the connection was formed. 'workspace' = auto-seeded intra-workspace
     * edge (primary → sibling) → surfaced to the model as an EXPLICIT-TRIGGER-ONLY
     * connection. 'user' = explicit follow → relevance-triggered (default).
     */
    origin?: 'user' | 'workspace'
    /** App variant of the callee when kind='app' — sharpens the explicit-only hint. */
    followingAppType?: 'distribution' | 'doc' | null
    /** Follower-side note set by the caller's owner (e.g. "for restaurant picks"). */
    callerNote?: string | null
  }>>

  /** A2A transport — applies cycle/depth/budget gates and runs the destination's query loop. */
  consultTransport: ConsultTransport
}

export function createInterAssistantTools(deps: InterAssistantDeps): Tool[] {
  const listConnectedAssistants = buildTool({
    name: 'listConnectedAssistants',
    description:
      'List all assistants connected to you. Each entry includes a `purpose` string (the callee owner\'s bio), an optional `note` (your own user\'s note about why they follow that assistant), and a `trigger` field. Use these to decide whether the question you have is actually relevant to that assistant. If nothing in `purpose` or `note` matches the user\'s question, do NOT call askAssistant for that assistant.\n\nThe `trigger` field is decisive:\n- `trigger: "relevance"` — an assistant you explicitly follow. Call askAssistant when the user\'s question plainly matches its `purpose`/`note`.\n- `trigger: "explicit-only"` — a specialist assistant in your own workspace (e.g. a doc or feed app). NEVER call askAssistant for it on your own initiative, for relevance, summaries, or background context. Delegate ONLY when the user explicitly asks for that assistant\'s capability by name or action (e.g. "make a doc page/view", "post this to the feed"). Otherwise answer with your own tools and knowledge.',
    inputSchema: z.object({}),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(_input, context) {
      try {
        const following = await deps.getFollowing(context.assistantId)

        if (following.length === 0) {
          return { data: 'You are not connected to any assistants. Workspace assistants are connected automatically when they join the workspace.' }
        }

        const results = following.map((f) => {
          const explicitOnly = f.origin === 'workspace'
          // Synthesize a relevance hint for auto-seeded workspace specialists
          // that have no owner-set bio/note, so the model can still tell what
          // the assistant is for without lowering the explicit-only bar.
          const note = f.callerNote
            ?? (explicitOnly
              ? (f.followingAppType === 'doc'
                  ? 'Workspace doc app — delegate ONLY when the user explicitly asks to create or edit a doc page or view.'
                  : f.followingAppType === 'distribution'
                    ? 'Workspace feed app — delegate ONLY when the user explicitly asks to draft or post to the feed.'
                    : 'Workspace specialist — delegate ONLY when the user explicitly asks to involve it.')
              : null)
          return {
            assistantId: f.followingAssistantId,
            name: f.followingAssistantName ?? 'Unknown',
            ownerHandle: f.followingOwnerHandle ?? 'unknown',
            purpose: f.followingBio ?? null,
            note,
            // Decisive gate for the model — see the tool description.
            trigger: explicitOnly ? 'explicit-only' : 'relevance',
          }
        })

        return { data: results }
      } catch (err) {
        return { data: `Failed to list following: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const askAssistant = buildTool({
    name: 'askAssistant',
    description:
      `Ask a connected assistant a question on behalf of your user. The other assistant runs its own query loop and responds with its own knowledge, tools, and data.

WHEN TO USE:
- The user explicitly references the other assistant by name ("ask DD Lobster…").
- The user asks for data that only that assistant has access to, AND the assistant's purpose/note (from listConnectedAssistants) clearly matches the question.

WHEN NOT TO USE:
- General-knowledge questions, weather, news, or anything you can answer with a web search or your own tools — answer directly.
- The user did not name the other assistant and the question is not obviously about their data.
- The connected assistant's purpose/note does not match the topic.
- The target's \`trigger\` (from listConnectedAssistants) is \`"explicit-only"\` and the user has NOT explicitly asked for that assistant's capability. These are specialist apps in your own workspace (e.g. doc, feed); calling them on inferred relevance, for context, or speculatively pollutes the conversation. Engage them ONLY on a direct user request to perform that capability ("create a doc view", "post to the feed").

If unsure whether to call this, do not call it. Answer with your own tools first, and only escalate to a connected assistant when the question is plainly about their domain.`,
    inputSchema: z.object({
      targetAssistantId: z.string().describe('The ID of the connected assistant to ask. Use listConnectedAssistants to find available assistants.'),
      question: z.string().describe('The question or request to send. Be specific and self-contained — the other assistant has no context about your conversation.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: true,
    timeoutMs: 60_000,

    async execute(input, context) {
      try {
        // 1. Verify following (accepted) — fast pre-check before transport.
        const following = await deps.isFollowing(context.assistantId, input.targetAssistantId)
        if (!following) {
          return {
            data: 'Not connected to this assistant. Only assistants in your own workspace are reachable.',
            isError: true,
          }
        }

        // 2. Resolve target's workspaceId (needed for ConsultRequest.target).
        const followingList = await deps.getFollowing(context.assistantId)
        const target = followingList.find((f) => f.followingAssistantId === input.targetAssistantId)
        if (!target) {
          return {
            data: 'Target assistant not in your connections list.',
            isError: true,
          }
        }

        // 3. Build the A2A ConsultRequest. Free-mode (no capabilityId).
        const request: ConsultRequest = {
          target: {
            workspaceId: target.followingWorkspaceId,
            assistantId: input.targetAssistantId,
          },
          message: {
            messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            role: 'user',
            parts: [{ kind: 'text', text: input.question }],
          },
          caller: {
            workspaceId: context.workspaceId ?? '',
            assistantId: context.assistantId,
            userId: context.userId,
            channelType: (context.channelType as ConsultRequest['caller']['channelType']) ?? 'web',
          },
          chain: {
            path: [],
            depth: 0,
            budget: INITIAL_BUDGET.user_turn,
          },
        }

        const response = await deps.consultTransport.send(request)
        const task = response.task

        // 4. Translate the Task into a tool-result string for the calling LLM.
        switch (task.status.state) {
          case 'completed': {
            // Extract conversational text from history (free-mode response).
            const lastAgentMsg = (task.history ?? [])
              .slice()
              .reverse()
              .find((m) => m.role === 'agent')
            const text = lastAgentMsg?.parts
              .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
              .map((p) => p.text)
              .join('\n') ?? ''
            return { data: text || 'The assistant did not produce a response.' }
          }
          case 'failed': {
            const errMsg = task.status.message?.parts
              ?.filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
              .map((p) => p.text)
              .join(' ') ?? 'unknown error'
            return { data: `Cross-assistant query failed: ${errMsg}`, isError: true }
          }
          case 'input_required':
          case 'auth_required':
          case 'canceled':
          case 'submitted':
          case 'working':
            // These transient states shouldn't surface for the in-process
            // transport's send() (which awaits terminal). Surface verbatim
            // so anomalies are visible.
            return {
              data: `Cross-assistant query ended in unexpected state '${task.status.state}'.`,
              isError: true,
            }
        }
      } catch (err) {
        return { data: `Cross-assistant query failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  return [listConnectedAssistants, askAssistant]
}
