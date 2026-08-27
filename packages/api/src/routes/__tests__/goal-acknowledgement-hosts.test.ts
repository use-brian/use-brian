/**
 * [COMP:goals/acknowledgement] Messaging adapter parity.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

const adapters = [
  ['Telegram', source('../telegram-byo.ts')],
  ['Slack', source('../slack.ts')],
  ['Discord', source('../discord.ts')],
  ['Feishu/Lark', source('../feishu.ts')],
  ['Microsoft Teams', source('../msteams.ts')],
  ['WeChat', source('../wechat.ts')],
  ['WhatsApp Cloud', source('../whatsapp-cloud.ts')],
  ['WhatsApp BYON', source('../../whatsapp/byon-runtime.ts')],
  ['custom bridge', source('../custom-channel-bridge.ts')],
] as const

describe('[COMP:goals/acknowledgement] messaging adapter hosts', () => {
  it.each(adapters)('delivers structural acceptance feedback on %s', (_name, host) => {
    expect(host).toContain('onGoalAccepted')
    expect(host).toMatch(/adapter\.sendMessage\([\s\S]{0,180}text: message/)
  })
})
