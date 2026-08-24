import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  FEISHU_CONNECTOR_SECRET: z.string().min(1, 'FEISHU_CONNECTOR_SECRET is required'),
  USEBRIAN_API_URL: z.string().url('USEBRIAN_API_URL must be a valid URL'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | null = null

export function getEnv(): Env {
  if (!cached) cached = envSchema.parse(process.env)
  return cached
}
