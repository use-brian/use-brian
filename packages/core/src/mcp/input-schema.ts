import Ajv, { type ValidateFunction } from 'ajv'
import Ajv2019 from 'ajv/dist/2019.js'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { z } from 'zod'

// Keep the wire schema alongside its Zod validation adapter. Converting an
// external JSON Schema to a generic Zod record loses its parameter definitions.
const wireSchemas = new WeakMap<object, Record<string, unknown>>()

export function getMcpInputJsonSchema(schema: object): Record<string, unknown> | undefined {
  return wireSchemas.get(schema)
}

export function createMcpInputSchema(schema: Record<string, unknown>) {
  let validate: ValidateFunction | undefined
  let compilationError: string | undefined
  const adapter = z.record(z.unknown()).superRefine((input, context) => {
    if (!validate && !compilationError) {
      try {
        const dialect = typeof schema.$schema === 'string' ? schema.$schema : ''
        const Constructor = dialect.includes('2020-12') ? Ajv2020
          : dialect.includes('2019-09') ? Ajv2019 : Ajv
        // Each schema gets an isolated registry: independent servers may reuse
        // $id. Never coerce values, remove arguments, or apply server defaults.
        const ajv = new Constructor({ strict: false, allErrors: true, logger: false })
        addFormats(ajv)
        validate = ajv.compile(schema)
        if ('$async' in validate && validate.$async) throw new Error('Asynchronous schemas are unsupported')
      } catch (error) {
        validate = undefined
        compilationError = error instanceof Error ? error.message : String(error)
      }
    }
    if (compilationError) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Cannot validate the discovered MCP schema: ${compilationError}. Refresh the connector or repair its tool schema` })
      return
    }
    if (validate!(input)) return
    for (const error of validate!.errors ?? []) {
      const path = error.instancePath.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
      if (error.keyword === 'required') path.push(error.params.missingProperty as string)
      if (error.keyword === 'additionalProperties') path.push(error.params.additionalProperty as string)
      context.addIssue({ code: z.ZodIssueCode.custom, path, message: error.message ?? 'Invalid argument' })
    }
  })
  wireSchemas.set(adapter, schema)
  return adapter
}

export function mcpArgumentError(tool: string, error: z.ZodError): string {
  const issues = error.issues.map(issue => `${issue.path.join('.') || '(args)'}: ${issue.message}`).join('; ')
  return `ERROR: invalid arguments for "${tool}": ${issues}. Re-check this tool's parameter names and types in its mcp_search entry, then retry.`
}
