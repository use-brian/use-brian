import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  /** Shared secret the API presents (and the connector requires) on every call. */
  DISCORD_CONNECTOR_SECRET: z.string().min(1, 'DISCORD_CONNECTOR_SECRET is required'),
  /** brian-api base URL — inbound messages POST to `${USEBRIAN_API_URL}/internal/discord/inbound`. */
  USEBRIAN_API_URL: z.string().url('USEBRIAN_API_URL must be a valid URL'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

export type Env = z.infer<typeof envSchema>

let _env: Env | null = null

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env)
  }
  return _env
}
