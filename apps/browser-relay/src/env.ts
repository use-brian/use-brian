import { z } from 'zod'

const envSchema = z.object({
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

let _env: Env | null = null

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env)
  }
  return _env
}
