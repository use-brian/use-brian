import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { WorkerManager } from './worker.js'

/**
 * Create the three worker tools backed by a WorkerManager.
 */
/**
 * Worker ids are per-request and in-memory: `spawn()` mints `worker_<n>` from
 * a counter that `reset()` zeroes at the end of every request, and the map
 * itself is cleared with it. So an id from an earlier turn does not resolve —
 * and there is deliberately NO listing tool to re-resolve it from, because the
 * only valid source is a `spawnWorker` result inside the SAME turn. Say that,
 * rather than sending the model hunting for a discovery tool that does not
 * exist (the exact loop this copy standard is closing).
 */
function workerNotFound(workerId: string): string {
  return (
    `Worker ${workerId} does not exist in this turn. ` +
    'Worker ids are per-turn and in-memory (they are minted by spawnWorker and discarded when the request ends), so an id from an earlier turn, another session, or another server instance never resolves here. ' +
    'There is no tool that lists workers: the only valid workerId is one spawnWorker returned to you in THIS turn. ' +
    'If you still need the research, call spawnWorker with a self-contained prompt. Do NOT retry this exact id.'
  )
}

export function createWorkerTools(manager: WorkerManager): {
  spawnWorker: Tool
  sendWorkerMessage: Tool
  stopWorker: Tool
} {
  const spawnWorker = buildTool({
    name: 'spawnWorker',
    description: 'Spawn a parallel research worker. Use for complex tasks needing 3+ independent lookups. Workers run in parallel using a fast, cheap model. Write self-contained prompts — workers cannot see this conversation. In research mode the worker pool is capped at 10 concurrent workers; if you try to spawn when full, this tool returns an error and you should wait for some to complete before spawning more.',
    inputSchema: z.object({
      // `description` is a cosmetic UI label (the `worker_start` payload).
      // It is TRUNCATED to 80 chars, not rejected — the model routinely
      // writes a ~100-char label for a research task, and a hard `.max(80)`
      // used to fail the whole spawnWorker call ("description: String must
      // contain at most 80 character(s)"). When that fired on a coordinator
      // research turn no worker spawned, the turn produced no visible text,
      // and the channel surfaced the canned "couldn't generate a reply"
      // banner (prod incident 2026-06-26, session 2d29043f). A display label
      // overflowing its width must never break a research dispatch.
      description: z.string().describe('Short task label shown in the UI (kept to 80 chars; a longer label is trimmed to fit). Describe THIS worker\'s task specifically — e.g. "Research Acme Corp on row 5", not persona preamble like "You are a researcher". One line, no period.').transform((s) => s.slice(0, 80)),
      prompt: z.string().describe('Self-contained research prompt. Include exactly what to search and what format to return results in.'),
    }),
    isReadOnly: false,

    async execute(input, context) {
      const result = manager.spawn(input.prompt, context, context.requestTools, input.description)
      if (!result) {
        // Concurrency cap hit. Surface a structured error so the model knows
        // to stop spawning this turn and wait for completions instead. The
        // active/cap numbers help the model reason about how many slots
        // remain and roughly when one will free up.
        const cap = manager.maxConcurrent ?? 'unbounded'
        const active = manager.activeCount
        return {
          data: `No worker was spawned: the pool is at capacity (${active}/${cap} running). Nothing about your prompt is wrong — there is simply no free slot. Do not call spawnWorker again this turn: emit your remaining tool calls if any, otherwise end the turn so Phase 4b can drain completed workers. Retrying this exact call in the NEXT turn, once some workers have finished, will succeed.`,
          isError: true,
        }
      }
      return { data: `Worker ${result.workerId} spawned and running in the background. Results will be delivered when ready.` }
    },
  })

  const sendWorkerMessage = buildTool({
    name: 'sendWorkerMessage',
    description: 'Send a follow-up message to an existing worker. Use when the worker has useful context from its previous research that would help with a follow-up question.',
    inputSchema: z.object({
      workerId: z.string().describe('Worker ID to message'),
      message: z.string().describe('Follow-up message for the worker'),
    }),

    async execute(input) {
      const status = manager.getStatus(input.workerId)
      if (!status) {
        return { data: workerNotFound(input.workerId), isError: true }
      }
      if (status !== 'completed') {
        return {
          data:
            `Worker ${input.workerId} is ${status}, so there is nothing to follow up on yet — sendWorkerMessage only reads a COMPLETED worker's result. ` +
            (status === 'running'
              ? 'Do NOT poll it: a finished worker delivers its result to you automatically, so end the turn and read what arrives instead of calling this again.'
              : `A ${status} worker never produces a result — spawn a fresh worker with spawnWorker if you still need this research, and do not retry this id.`),
          isError: true,
        }
      }
      // For now, return the existing result — full re-query with context is a future enhancement
      const result = manager.getResult(input.workerId)
      return { data: result ?? 'No result available' }
    },
  })

  const stopWorker = buildTool({
    name: 'stopWorker',
    description: 'Stop a running worker. Use when the information is no longer needed.',
    inputSchema: z.object({
      workerId: z.string().describe('Worker ID to stop'),
    }),

    async execute(input) {
      const stopped = manager.stop(input.workerId)
      if (!stopped) {
        const status = manager.getStatus(input.workerId)
        if (!status) return { data: workerNotFound(input.workerId), isError: true }
        return {
          data:
            `Worker ${input.workerId} is already ${status}, so there was nothing to stop — stopWorker only aborts a RUNNING worker. ` +
            'Nothing changed. Do NOT retry this id; if the worker completed, its result reaches you on its own.',
          isError: true,
        }
      }
      return { data: `Worker ${input.workerId} stopped.` }
    },
  })

  return { spawnWorker, sendWorkerMessage, stopWorker }
}
