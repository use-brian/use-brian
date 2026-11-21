import type { ChannelAdapter } from '@use-brian/channels'
import { describeToolInput, humanizeToolName } from '@use-brian/shared'
import type { ChannelHooks } from './channel-pipeline.js'

type ProgressHooks = Pick<Required<ChannelHooks>,
  'onProcessingStart' | 'onStatus' | 'onToolStart' | 'onToolInput' | 'onToolResult'>

const STATUS_THROTTLE_MS = 1200
const THINKING = 'Thinking...'

// [COMP:api/channel-editable-status] — one editable progress message per turn.
export function createEditableChannelStatus(
  adapter: Pick<ChannelAdapter, 'sendStatus' | 'editMessage'>,
  channelId: string,
) {
  let messageId: string | undefined
  let lastStatusUpdate = 0
  const tools: Array<{ id: string; name: string; description?: string; done: boolean }> = []

  function formatToolStatus(): string {
    const active = tools.filter((tool) => !tool.done).at(-1)
    if (active) return active.description ?? humanizeToolName(active.name)
    const last = tools.at(-1)
    return last ? `Done: ${last.description ?? humanizeToolName(last.name)}` : THINKING
  }

  async function setStatus(text: string, force = false): Promise<void> {
    const now = Date.now()
    if (!force && now - lastStatusUpdate < STATUS_THROTTLE_MS) return
    lastStatusUpdate = now
    try {
      if (messageId) {
        await adapter.editMessage(channelId, messageId, { text })
      } else {
        messageId = await adapter.sendStatus(channelId, text)
      }
    } catch {
      // Progress delivery is best-effort.
    }
  }

  const hooks: ProgressHooks = {
    onProcessingStart: () => setStatus(THINKING, true),
    onStatus: (message) => setStatus(message, true),
    async onToolStart(id, name) {
      tools.push({ id, name, done: false })
      await setStatus(formatToolStatus())
    },
    async onToolInput(id, name, input) {
      const description = describeToolInput(name, input)
      if (!description) return
      const tool = tools.find((entry) => entry.id === id)
      if (tool) tool.description = description
      await setStatus(formatToolStatus())
    },
    async onToolResult(results) {
      for (const block of results) {
        if (block.type !== 'tool_result') continue
        const tool = tools.find((entry) => entry.id === block.toolUseId)
        if (tool) tool.done = true
      }
      await setStatus(formatToolStatus())
    },
  }
  return {
    hooks,
    get messageId() { return messageId },
    clear() { messageId = undefined },
  }
}
