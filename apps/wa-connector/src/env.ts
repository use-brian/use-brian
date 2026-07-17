import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  WA_CONNECTOR_SECRET: z.string().min(1, 'WA_CONNECTOR_SECRET is required'),
  USEBRIAN_API_URL: z.string().url('USEBRIAN_API_URL must be a valid URL'),
  GCS_BUCKET_NAME: z.string().default('sidanclaw-wa-creds'),
  // BYON ingest channels persist Baileys creds to Postgres (table
  // `wa_auth_state`) instead of GCS. Optional: when unset, the Postgres pool is
  // null and a BYON connect 503s. Not `.url()` — Cloud SQL uses a socket form.
  DATABASE_URL: z.string().min(1).optional(),
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
