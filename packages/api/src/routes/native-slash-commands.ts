import {
  loadBuiltinSkills,
  prepareNativeSlashCommands,
  type NativeSlashCommandCatalog,
  type NativeSlashCommandTarget,
  type WorkflowStore,
} from '@use-brian/core'
import type { SkillStore } from '../db/skill-store.js'
import {
  createDiscordApi,
  createTelegramApi,
  DISCORD_APPLICATION_COMMANDS,
  TELEGRAM_BOT_COMMANDS,
} from '@use-brian/channels'
import type {
  ChannelIntegrationStore,
  DiscordCredentials,
  TelegramCredentials,
} from '../db/channel-integrations.js'

/** Build the workspace roster used both for provider registration and dispatch. */
export async function buildWorkspaceNativeSlashCommands(params: {
  userId: string
  workspaceId: string
  skillStore?: SkillStore
  workflowStore?: WorkflowStore
}): Promise<NativeSlashCommandCatalog> {
  const targets = new Map<string, NativeSlashCommandTarget>()

  for (const skill of loadBuiltinSkills()) {
    targets.set(`skill:${skill.id}`, {
      kind: 'skill',
      slug: skill.id,
      name: skill.name,
      description: skill.description,
    })
  }

  if (params.skillStore) {
    const skills = await params.skillStore.listForWorkspaceContent(params.workspaceId, params.userId)
    for (const skill of skills) {
      targets.set(`skill:${skill.id}`, {
        kind: 'skill',
        slug: skill.id,
        name: skill.name,
        description: skill.description,
      })
    }
  }

  if (params.workflowStore) {
    const workflows = await params.workflowStore.list(params.userId, params.workspaceId)
    for (const workflow of workflows) {
      if (!workflow.enabled) continue
      targets.set(`workflow:${workflow.id}`, {
        kind: 'workflow',
        workflowId: workflow.id,
        name: workflow.name,
        description: workflow.description,
      })
    }
  }

  return prepareNativeSlashCommands([...targets.values()])
}

/** Reconcile every active native-command-capable integration in a workspace. */
export async function syncWorkspaceNativeSlashCommands(params: {
  userId: string
  workspaceId: string
  skillStore?: SkillStore
  workflowStore?: WorkflowStore
  integrationStore: ChannelIntegrationStore
}): Promise<void> {
  const catalog = await buildWorkspaceNativeSlashCommands(params)
  const integrations = await params.integrationStore.listForWorkspace(params.userId, params.workspaceId)

  await Promise.all(integrations
    .filter((integration) =>
      integration.status === 'active' &&
      (integration.channelType === 'telegram' || integration.channelType === 'discord'))
    .map(async (integration) => {
      const row = await params.integrationStore.getForUserWithCredentials(params.userId, integration.id)
      if (!row) return
      if (integration.channelType === 'telegram') {
        const credentials = row.credentials as TelegramCredentials
        await createTelegramApi({ token: credentials.bot_token }).setMyCommands([
          ...TELEGRAM_BOT_COMMANDS,
          ...catalog.commands.map(({ name, description }) => ({ command: name, description })),
        ])
        return
      }

      const credentials = row.credentials as DiscordCredentials
      if (!integration.botUserId) return
      await createDiscordApi({ token: credentials.bot_token }).replaceGlobalApplicationCommands(
        integration.botUserId,
        [
          ...DISCORD_APPLICATION_COMMANDS,
          ...catalog.commands.map(({ name, description }) => ({
            name,
            description,
            type: 1 as const,
            options: [{
              name: 'arguments',
              description: 'Arguments for this command',
              type: 3 as const,
            }],
          })),
        ],
      )
    }))

  if (catalog.omitted.length > 0) {
    console.warn(`[channels] native command cap omitted ${catalog.omitted.length} workspace command(s)`)
  }
}
