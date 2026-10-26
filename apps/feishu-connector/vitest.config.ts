import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Synthetic tests use explicit environment only; never discover workspace dotenv.
  envDir: false,
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
})
