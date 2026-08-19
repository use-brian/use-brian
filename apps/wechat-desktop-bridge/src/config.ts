/**
 * Environment → typed config (zod at the boundary).
 * Spec: docs/architecture/channels/wechat-desktop.md → "Configuration".
 */
import { z } from 'zod'

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => ['true', '1', 'yes'].includes((v ?? '').trim().toLowerCase()))

const schema = z.object({
  BRIAN_API_URL: z
    .string({ required_error: 'BRIAN_API_URL is required (e.g. https://api.usebrian.ai)' })
    .url('BRIAN_API_URL must be a URL such as https://api.usebrian.ai')
    .transform((u) => u.replace(/\/+$/, '')),
  BRIAN_CHANNEL_ID: z
    .string({ required_error: 'BRIAN_CHANNEL_ID is required (the custom channel id from Studio)' })
    .min(1, 'BRIAN_CHANNEL_ID is required (the custom channel id from Studio)'),
  BRIAN_BRIDGE_TOKEN: z
    .string({ required_error: 'BRIAN_BRIDGE_TOKEN is required (the ubc_ token shown once in Studio)' })
    .min(1, 'BRIAN_BRIDGE_TOKEN is required (the ubc_ token shown once in Studio)'),
  AGENT_WECHAT_URL: z
    .string()
    .url('AGENT_WECHAT_URL must be a URL')
    .default('http://agent-wechat:6174')
    .transform((u) => u.replace(/\/+$/, '')),
  AGENT_WECHAT_TOKEN: z
    .string({ required_error: 'AGENT_WECHAT_TOKEN is required (the container bearer token from /data/auth-token)' })
    .min(1, 'AGENT_WECHAT_TOKEN is required (the container bearer token from /data/auth-token)'),
  BRIDGE_STATE_FILE: z.string().min(1).default('/data/bridge-state.json'),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  BACKFILL_ON_FIRST_BOOT: boolFromEnv,
  BRIDGE_PORT: z.coerce.number().int().positive().default(8086),
})

export type BridgeConfig = z.infer<typeof schema>

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Parse an env map; throws a ConfigError whose message lists every problem, one per line. */
export function parseConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`)
    throw new ConfigError(`Invalid configuration:\n  ${lines.join('\n  ')}`)
  }
  return parsed.data
}
