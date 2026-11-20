import type { SessionOptions, ToolDefinition, ToolSchemaRegistrationMode } from './types.js'

/** Opt-in presentation plan. Legacy drivers always retain their complete eager list. */
export function registeredToolDefinitions(
  options: Pick<SessionOptions, 'tools' | 'toolRegistration'>,
  mode: ToolSchemaRegistrationMode,
): readonly ToolDefinition[] {
  const plan = options.toolRegistration
  if (plan?.mode === 'deferred') {
    if (mode === 'dynamic') return plan.active
    if (mode === 'native-deferred') return plan.catalog
  }
  return options.tools ?? []
}

/** Render at the actual driver boundary, not from a route's pre-filter tool map.
 * A fallback can use a different schema mode from the primary. Discovery only
 * describes the admitted catalog; it neither adds executors nor grants access.
 */
export function toolDiscoveryInstructions(
  options: Pick<SessionOptions, 'tools' | 'toolRegistration'>,
  mode: ToolSchemaRegistrationMode,
): string {
  if (options.toolRegistration?.mode !== 'deferred' || mode === 'eager') return ''
  const activeNames = new Set(options.toolRegistration.active.map(tool => tool.name))
  if (!options.toolRegistration.catalog.some(tool => !activeNames.has(tool.name))) return ''
  const definitions = registeredToolDefinitions(options, mode)
  if (!definitions.length) return ''
  const unifiedSearch = options.toolRegistration.discoveryTool === 'mcp_search' && definitions.some(tool => tool.name === 'mcp_search')
  if (unifiedSearch) {
    const loading = mode === 'native-deferred'
      ? ' For a direct native call whose schema is not already available, use the provider\'s native tool search for that exact name first. An advertised mcp_call server="brian" route needs no provider-native schema loading.'
      : ' Matching native schemas are loaded for the next call.'
    return '# Tool schema discovery\n\n`mcp_search` searches the final admitted Brian tool catalog together with indexed connected-source tools. Use it for any unlisted capability; do not treat the connector-source count as the total tool count. An empty query lists the inventory in pages; follow nextOffset until null. Keyword results are not a complete inventory. Follow the returned invocation route: admitted native tools can use an advertised mcp_call server="brian" route through the host execution guards, or be called directly with a loaded schema; indexed tools retain their exact source route.' + loading + ' Use schemas already supplied without another search. Discovery does not grant execution permission or override explicit policy/availability refusals.'
  }
  const discovery = mode === 'native-deferred'
    ? 'Some admitted Brian tools have deferred parameter schemas. Use the provider\'s native tool search to discover them before denying an unlisted Brian capability just because its schema is absent.'
    : definitions.some(tool => tool.name === 'discoverTools')
      ? 'Some admitted Brian tools have deferred parameter schemas. Use `discoverTools` to find and load them before denying an unlisted Brian capability just because its schema is absent.'
      : ''
  if (!discovery) return ''
  const connectors = definitions.some(tool => tool.name === 'mcp_search')
    ? ' `mcp_search` searches a separate connected-service catalog, not all Brian tools. A miss there does not rule out a Brian tool; a miss in Brian tool discovery does not rule out a folded connector tool. Search the relevant catalog before denying an unlisted capability for lack of a schema.'
    : ''
  return `# Tool schema discovery\n\n${discovery}${connectors} Use an already supplied schema directly rather than searching again. Discovery supplies schemas, not execution permission. Explicit availability and policy refusals remain authoritative; do not use discovery to bypass them.`
}
