import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const routesDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillStoreNames = [
  'workspaceSkillStore',
  'workspaceSkillEnablementStore',
  'workspaceSkillFilesStore',
]
const storeNames = ['workflowStore', ...skillStoreNames]
const channelRoutes = [
  'slack.ts',
  'telegram-byo.ts',
  'discord.ts',
  'whatsapp-cloud.ts',
  'msteams.ts',
  'feishu.ts',
  'wechat.ts',
  'custom-channel-bridge.ts',
]

describe('[COMP:api/channel-pipeline] shared store wiring', () => {
  it('passes shared stores from the pipeline into injectSkills', () => {
    const pipeline = readFileSync(join(routesDir, 'channel-pipeline.ts'), 'utf8')
    const injectAt = pipeline.indexOf('const skillResult = await injectSkills({')
    expect(injectAt).toBeGreaterThan(-1)
    const injectBlock = pipeline.slice(injectAt, injectAt + 3_000)
    expect(injectBlock).toContain('workspaceSkillStore: workspaceSkillStore ?? createDbWorkspaceSkillStore()')
    expect(injectBlock).toContain('workspaceSkillEnablementStore:')
    expect(injectBlock).toContain('workspaceSkillEnablementStore ?? createDbWorkspaceSkillEnablementStore()')
    expect(injectBlock).toContain('workspaceSkillFilesStore: params.workspaceSkillFilesStore')
  })

  it('forwards shared stores through every channel route', () => {
    for (const file of channelRoutes) {
      const source = readFileSync(join(routesDir, file), 'utf8')
      for (const storeName of storeNames) {
        expect(source, `${file} does not forward ${storeName}`).toMatch(
          new RegExp(`${storeName}: (?:params|options)\\.${storeName}`),
        )
      }
    }
  })

  it('supplies shared stores at every boot channel mount', () => {
    const boot = readFileSync(join(routesDir, '..', 'boot.ts'), 'utf8')
    const mounts = [
      'telegramByoRoutes({',
      'slackRoutes({',
      'whatsappCloudRoutes({',
      'msteamsRoutes({',
      'discordRoutes({',
      'wechatRoutes({',
      'feishuRoutes({',
      'customChannelBridgeRoutes({',
    ]
    for (const mount of mounts) {
      const at = boot.indexOf(mount)
      expect(at, `${mount} mount not found`).toBeGreaterThan(-1)
      const block = boot.slice(at, at + 3_500)
      for (const storeName of storeNames) {
        expect(block, `${mount} does not supply ${storeName}`).toContain(storeName)
      }
    }

    const directPipelineAt = boot.indexOf('await processChannelMessage({')
    expect(directPipelineAt).toBeGreaterThan(-1)
    const directPipelineBlock = boot.slice(directPipelineAt, directPipelineAt + 6_000)
    for (const storeName of storeNames) {
      expect(directPipelineBlock).toContain(storeName)
    }
  })
})
