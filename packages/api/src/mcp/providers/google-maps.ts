/**
 * Google Maps provider (M3 WP2).
 *
 * Maps is a deployment-keyed first-party read capability, not a connector
 * instance: boot builds the env-gated tools into the base tool map, and this
 * module only moves them into their own `google-maps` search source. It does
 * not appear in `OFFICIAL_CONNECTOR_TOOLS`.
 *
 * See docs/architecture/integrations/google-maps.md and
 * docs/architecture/integrations/mcp.md → "Provider activation".
 */
import { createGoogleMapsTools, GOOGLE_MAPS_TOOL_NAMES } from '@use-brian/core/tools/base/google-maps.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import { describeBuiltTools, memoDescribe } from './describe.js'
import type { ProviderModule } from './types.js'

/** The boot-built tool map Maps tools are read from. */
export type GoogleMapsInstances = { bootTools: ReadonlyMap<string, Tool> }

/** Remove the env-gated Maps tools from `tools` and return them in canonical order. */
export function pluckGoogleMapsTools(tools: Map<string, Tool>): Tool[] {
  const googleMapsTools: Tool[] = []
  for (const name of GOOGLE_MAPS_TOOL_NAMES) {
    const tool = tools.get(name)
    if (!tool) continue
    googleMapsTools.push(tool)
    tools.delete(name)
  }
  return googleMapsTools
}

const inertMapsApi = {
  callTool: async () => { throw new Error('Google Maps descriptors are inert; activate the provider to call a tool.') },
}

export const googleMapsProvider: ProviderModule<GoogleMapsInstances> = {
  family: 'google-maps',
  describe: memoDescribe(() => describeBuiltTools('google-maps', 'google-maps', createGoogleMapsTools(inertMapsApi))),
  activate: async (_ctx, instances) => GOOGLE_MAPS_TOOL_NAMES.flatMap((name) => {
    const tool = instances.bootTools.get(name)
    return tool ? [tool] : []
  }),
}
