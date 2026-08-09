import { z } from 'zod'

const envSchema = z.object({
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().default(8080),
  /**
   * Shared secret the api presents on `/internal/browser/*` calls
   * (X-Relay-Secret, constant-time checked — the connector-app pattern).
   */
  BROWSER_RELAY_SECRET: z.string().min(1, 'BROWSER_RELAY_SECRET is required'),
  /**
   * The SAME JWT secret the api signs with (P1.3): pairing tokens minted by
   * `POST /api/browser-extension/pair` verify here.
   */
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

export type Env = z.infer<typeof envSchema>

export function parseEnv(input: NodeJS.ProcessEnv): Env {
  return envSchema.parse(input)
}

let _env: Env | null = null

export function getEnv(): Env {
  if (!_env) {
    _env = parseEnv(process.env)
  }
  return _env
}
