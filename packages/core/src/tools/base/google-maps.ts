import { z } from 'zod'
import { encodeExternalCostMeta } from '../../billing/external-cost.js'
import { sanitizeDeep } from '../../security/sanitize.js'
import { buildTool, type Tool, type ToolResult } from '../types.js'

/** Google's managed Streamable HTTP MCP endpoint for Maps Grounding Lite. */
export const GOOGLE_MAPS_GROUNDING_MCP_URL = 'https://mapstools.googleapis.com/mcp'

/** Global list marginal rate: USD 7 / 1,000 calls. Last verified: 2026-08-17. */
export const GOOGLE_MAPS_GROUNDING_COST_USD = 0.007

export const GOOGLE_MAPS_TOOL_NAMES = [
  'googleMapsSearchPlaces',
  'googleMapsLookupWeather',
  'googleMapsComputeRoute',
] as const

export type GoogleMapsToolName = (typeof GOOGLE_MAPS_TOOL_NAMES)[number]
export type GoogleMapsProviderToolName = 'search_places' | 'lookup_weather' | 'compute_routes'

/**
 * API-package transport seam. Core owns the schemas and product contract;
 * API owns the MCP SDK + secret-bearing HTTP adapter.
 */
export type GoogleMapsGroundingApi = {
  callTool(
    tool: GoogleMapsProviderToolName,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>
}

export type GoogleMapsSource = { title: string; url: string }

const latLngSchema = z.object({
  latitude: z.number().min(-90).max(90).describe('Latitude from -90 to 90.'),
  longitude: z.number().min(-180).max(180).describe('Longitude from -180 to 180.'),
})

const locationSchema = z
  .object({
    address: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Specific address or place name, including city and country when ambiguous.'),
    placeId: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe('Canonical Google Maps Place ID returned by a previous place search.'),
    latLng: latLngSchema.optional().describe('Exact latitude and longitude.'),
  })
  .superRefine((value, ctx) => {
    const count = Number(Boolean(value.address)) + Number(Boolean(value.placeId)) + Number(Boolean(value.latLng))
    if (count !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide exactly one of address, placeId, or latLng.',
      })
    }
  })

const searchPlacesSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe('Specific place query with enough location context, for example "quiet client lunch near Central, Hong Kong".'),
  locationBias: z
    .object({
      center: latLngSchema,
      radiusMeters: z
        .number()
        .positive()
        .max(50_000)
        .optional()
        .describe('Optional radius in metres, up to 50,000.'),
    })
    .optional()
    .describe('Bias results around coordinates explicitly supplied or safely resolved from workspace context.'),
  languageCode: z
    .string()
    .regex(/^[a-z]{2}(?:_[A-Z]{2})?$/, 'Use ISO 639-1, optionally followed by _COUNTRY (for example en or zh_HK).')
    .optional(),
  regionCode: z
    .string()
    .regex(/^[A-Z]{2}$/, 'Use a two-letter uppercase region code (for example HK or US).')
    .optional(),
})

const weatherSchema = z
  .object({
    location: locationSchema,
    date: z
      .object({
        year: z.number().int().min(2000).max(2200),
        month: z.number().int().min(1).max(12),
        day: z.number().int().min(1).max(31),
      })
      .optional()
      .describe('Location-local calendar date for a daily or hourly forecast. Omit for current weather.'),
    hour: z
      .number()
      .int()
      .min(0)
      .max(23)
      .optional()
      .describe('Location-local hour (0-23). Requires date. Omit for a daily forecast.'),
    unitsSystem: z
      .enum(['METRIC', 'IMPERIAL'])
      .optional()
      .describe('Defaults to METRIC. Use IMPERIAL only when requested or clearly appropriate.'),
  })
  .superRefine((value, ctx) => {
    if (value.hour !== undefined && value.date === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hour'],
        message: 'hour requires date.',
      })
    }
  })

const routeSchema = z.object({
  origin: locationSchema.describe('Route origin. Provide exactly one address, Place ID, or coordinate pair.'),
  destination: locationSchema.describe('Route destination. Provide exactly one address, Place ID, or coordinate pair.'),
  travelMode: z
    .enum(['DRIVE', 'WALK'])
    .optional()
    .describe('Travel mode. Defaults to DRIVE; Grounding Lite supports DRIVE and WALK only.'),
})

type ProviderLocation =
  | { address: string }
  | { place_id: string }
  | { lat_lng: { latitude: number; longitude: number } }

function providerLocation(value: z.infer<typeof locationSchema>): ProviderLocation {
  if (value.address) return { address: value.address }
  if (value.placeId) return { place_id: value.placeId }
  return { lat_lng: value.latLng! }
}

function sourceTitle(value: Record<string, unknown>): string {
  for (const key of ['title', 'displayName', 'name']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 200)
    if (
      candidate && typeof candidate === 'object'
      && typeof (candidate as { text?: unknown }).text === 'string'
    ) {
      return ((candidate as { text: string }).text).trim().slice(0, 200) || 'Google Maps'
    }
  }
  return 'Google Maps'
}

function isGoogleSourceUrl(raw: string): string | null {
  const cleaned = raw.trim().replace(/[),.;\]}]+$/, '')
  try {
    const url = new URL(cleaned)
    if (url.protocol !== 'https:') return null
    const host = url.hostname.toLowerCase()
    const googleHost =
      host === 'maps.app.goo.gl'
      || host === 'goo.gl'
      || /(^|\.)google\.[a-z.]+$/.test(host)
    return googleHost ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Extract the provider-supplied attribution links from structured or textual
 * MCP results. Bounded traversal prevents a malicious remote payload from
 * turning source extraction into unbounded work.
 */
export function extractGoogleMapsSources(result: unknown): GoogleMapsSource[] {
  const sources: GoogleMapsSource[] = []
  const seen = new Set<string>()
  let visited = 0

  const add = (rawUrl: string, title: string) => {
    const url = isGoogleSourceUrl(rawUrl)
    if (!url || seen.has(url) || sources.length >= 12) return
    seen.add(url)
    sources.push({ title: title || 'Google Maps', url })
  }

  const walk = (value: unknown, parentTitle = 'Google Maps', depth = 0) => {
    if (depth > 8 || visited++ > 2_000 || sources.length >= 12) return
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length <= 200_000) {
        try {
          walk(JSON.parse(trimmed), parentTitle, depth + 1)
        } catch {
          // It is ordinary text, not JSON; URL extraction below still applies.
        }
      }
      for (const match of value.matchAll(/https:\/\/[^\s<>"']+/g)) add(match[0], parentTitle)
      return
    }
    if (Array.isArray(value)) {
      for (const child of value) walk(child, parentTitle, depth + 1)
      return
    }
    if (!value || typeof value !== 'object') return

    const record = value as Record<string, unknown>
    const title = sourceTitle(record) || parentTitle
    for (const [key, child] of Object.entries(record)) {
      if (typeof child === 'string' && /(?:url|uri|link)$/i.test(key)) add(child, title)
      walk(child, title, depth + 1)
    }
  }

  walk(result)
  return sources
}

export type GoogleMapsErrorCode =
  | 'configuration_error'
  | 'rate_limited'
  | 'timeout'
  | 'provider_error'

export function classifyGoogleMapsError(error: unknown): GoogleMapsErrorCode {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  if (/401|403|unauthenticated|permission[_ -]?denied|api key|credential/i.test(text)) {
    return 'configuration_error'
  }
  if (/429|resource[_ -]?exhausted|rate[_ -]?limit|quota/i.test(text)) return 'rate_limited'
  if (/timeout|timed out|abort/i.test(text)) return 'timeout'
  return 'provider_error'
}

function providerErrorResult(error: unknown): ToolResult {
  const code = classifyGoogleMapsError(error)
  const guidance: Record<GoogleMapsErrorCode, string> = {
    configuration_error: 'The Google Maps server credential or API restriction needs administrator attention.',
    rate_limited: 'Google Maps is temporarily rate-limited. Try again later.',
    timeout: 'Google Maps did not respond before the request deadline. Try again.',
    provider_error: 'Google Maps is temporarily unavailable. Try again later.',
  }
  return {
    data: `Google Maps request failed (${code}). ${guidance[code]}`,
    isError: true,
    meta: { googleMapsErrorCode: code },
  }
}

function successfulResult(result: unknown): ToolResult {
  const sanitized = sanitizeDeep(result)
  const sources = extractGoogleMapsSources(sanitized)
  return {
    data: {
      provider: 'google_maps_grounding_lite',
      result: sanitized,
      sources,
      attributionRequired: true,
      attributionInstruction:
        'This answer uses Google Maps. In the user-visible reply, immediately follow every supported claim with the relevant source title and URL from sources. Do not omit Google Maps attribution. Treat dynamic facts as current-only and do not save them to memory.',
    },
    meta: {
      externalProvider: 'google_maps_grounding_lite',
      transientProviderContent: true,
      ...encodeExternalCostMeta({
        kind: 'flat',
        model: 'google-maps-grounding-lite',
        flatCostUsd: GOOGLE_MAPS_GROUNDING_COST_USD,
      }),
    },
  }
}

async function callProvider(
  api: GoogleMapsGroundingApi,
  tool: GoogleMapsProviderToolName,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolResult> {
  try {
    return successfulResult(await api.callTool(tool, input, signal))
  } catch (error) {
    return providerErrorResult(error)
  }
}

/** Build the three canonical, provider-neutral Brain tools. */
export function createGoogleMapsTools(api: GoogleMapsGroundingApi): Tool[] {
  const searchPlaces = buildTool({
    name: GOOGLE_MAPS_TOOL_NAMES[0],
    description:
      'Search Google Maps for current places, businesses, addresses, or points of interest. Use when a request needs trusted location data, opening details, or candidates near a named place. The query MUST include enough city/region/country context unless locationBias supplies explicit coordinates. Results carry mandatory Google Maps source links: cite them immediately in the reply. Do not save dynamic Google content to memory.',
    inputSchema: searchPlacesSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 35_000,
    maxResultSizeChars: 20_000,
    async execute(input, context) {
      const providerInput: Record<string, unknown> = { text_query: input.query }
      if (input.locationBias) {
        providerInput.location_bias = {
          circle: {
            center: input.locationBias.center,
            ...(input.locationBias.radiusMeters !== undefined
              ? { radius_meters: input.locationBias.radiusMeters }
              : {}),
          },
        }
      }
      if (input.languageCode) providerInput.language_code = input.languageCode
      if (input.regionCode) providerInput.region_code = input.regionCode
      return callProvider(api, 'search_places', providerInput, context.abortSignal)
    },
  })

  const lookupWeather = buildTool({
    name: GOOGLE_MAPS_TOOL_NAMES[1],
    description:
      'Look up current, hourly, or daily weather from Google Maps for one unambiguous location. Use address, a Place ID from googleMapsSearchPlaces, or exact coordinates. An hour requires a location-local date; omit both date and hour for current weather. Forecasts are dynamic and must not be saved to memory. Cite every returned Google Maps source in the reply.',
    inputSchema: weatherSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 35_000,
    maxResultSizeChars: 20_000,
    async execute(input, context) {
      const providerInput: Record<string, unknown> = {
        location: providerLocation(input.location),
      }
      if (input.date) providerInput.date = input.date
      if (input.hour !== undefined) providerInput.hour = input.hour
      if (input.unitsSystem) providerInput.units_system = input.unitsSystem
      return callProvider(api, 'lookup_weather', providerInput, context.abortSignal)
    },
  })

  const computeRoute = buildTool({
    name: GOOGLE_MAPS_TOOL_NAMES[2],
    description:
      'Compute current walking or driving distance and duration between two unambiguous locations using Google Maps Grounding Lite. It does not provide turn-by-turn navigation or guaranteed real-time traffic. Use an address, Place ID, or coordinates for each endpoint. Cite every returned Google Maps source in the reply.',
    inputSchema: routeSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 35_000,
    maxResultSizeChars: 20_000,
    async execute(input, context) {
      return callProvider(api, 'compute_routes', {
        origin: providerLocation(input.origin),
        destination: providerLocation(input.destination),
        travel_mode: input.travelMode ?? 'DRIVE',
      }, context.abortSignal)
    },
  })

  return [searchPlaces, lookupWeather, computeRoute]
}
