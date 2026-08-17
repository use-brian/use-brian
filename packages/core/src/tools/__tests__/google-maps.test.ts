import { describe, expect, it, vi } from 'vitest'
import {
  GOOGLE_MAPS_GROUNDING_COST_USD,
  classifyGoogleMapsError,
  createGoogleMapsTools,
  extractGoogleMapsSources,
  type GoogleMapsGroundingApi,
} from '../base/google-maps.js'

const context = {
  userId: 'user-1',
  assistantId: 'assistant-1',
  sessionId: 'session-1',
  appId: 'test',
  channelType: 'web',
  channelId: 'channel-1',
  abortSignal: new AbortController().signal,
}

describe('[COMP:tools/google-maps] Google Maps tools', () => {
  it('translates place search input and returns attributed transient evidence', async () => {
    const callTool = vi.fn<GoogleMapsGroundingApi['callTool']>().mockResolvedValue({
      places: [{
        displayName: { text: 'Example Cafe' },
        googleMapsUri: 'https://maps.google.com/?cid=123',
        editorialSummary: 'Quiet\u202E option',
      }],
    })
    const [tool] = createGoogleMapsTools({ callTool })

    const result = await tool.execute({
      query: 'quiet cafe in Central, Hong Kong',
      locationBias: {
        center: { latitude: 22.2819, longitude: 114.1586 },
        radiusMeters: 1_500,
      },
      languageCode: 'en',
      regionCode: 'HK',
    }, context)

    expect(callTool).toHaveBeenCalledWith('search_places', {
      text_query: 'quiet cafe in Central, Hong Kong',
      location_bias: {
        circle: {
          center: { latitude: 22.2819, longitude: 114.1586 },
          radius_meters: 1_500,
        },
      },
      language_code: 'en',
      region_code: 'HK',
    }, context.abortSignal)
    expect(result.isError).toBeFalsy()
    expect(result.meta).toMatchObject({
      externalProvider: 'google_maps_grounding_lite',
      transientProviderContent: true,
      externalCost_kind: 'flat',
      externalCost_flatCostUsd: GOOGLE_MAPS_GROUNDING_COST_USD,
    })
    const data = result.data as {
      provider: string
      result: unknown
      sources: Array<{ title: string; url: string }>
      attributionRequired: boolean
    }
    expect(data.provider).toBe('google_maps_grounding_lite')
    expect(data.attributionRequired).toBe(true)
    expect(JSON.stringify(data.result)).not.toContain('\u202E')
    expect(data.sources).toEqual([{
      title: 'Example Cafe',
      url: 'https://maps.google.com/?cid=123',
    }])
  })

  it('translates weather and route locations without leaking provider vocabulary', async () => {
    const callTool = vi.fn<GoogleMapsGroundingApi['callTool']>().mockResolvedValue({ ok: true })
    const [, weather, route] = createGoogleMapsTools({ callTool })

    await weather.execute({
      location: { placeId: 'place-example-1' },
      date: { year: 2026, month: 8, day: 20 },
      hour: 14,
      unitsSystem: 'METRIC',
    }, context)
    await route.execute({
      origin: { address: 'Central, Hong Kong' },
      destination: { latLng: { latitude: 22.293, longitude: 114.169 } },
      travelMode: 'WALK',
    }, context)

    expect(callTool).toHaveBeenNthCalledWith(1, 'lookup_weather', {
      location: { place_id: 'place-example-1' },
      date: { year: 2026, month: 8, day: 20 },
      hour: 14,
      units_system: 'METRIC',
    }, context.abortSignal)
    expect(callTool).toHaveBeenNthCalledWith(2, 'compute_routes', {
      origin: { address: 'Central, Hong Kong' },
      destination: { lat_lng: { latitude: 22.293, longitude: 114.169 } },
      travel_mode: 'WALK',
    }, context.abortSignal)
  })

  it('validates exclusive locations and the date required by hourly weather', () => {
    const [, weather] = createGoogleMapsTools({ callTool: vi.fn() })
    expect(weather.inputSchema.safeParse({
      location: { address: 'Hong Kong', placeId: 'duplicate' },
    }).success).toBe(false)
    expect(weather.inputSchema.safeParse({
      location: { address: 'Hong Kong' },
      hour: 8,
    }).success).toBe(false)
  })

  it('extracts only bounded Google attribution URLs', () => {
    expect(extractGoogleMapsSources(JSON.stringify({
      title: 'Example Park',
      links: [
        'https://maps.app.goo.gl/example',
        'https://example.com/not-google',
      ],
    }))).toEqual([{
      title: 'Example Park',
      url: 'https://maps.app.goo.gl/example',
    }])
  })

  it('returns provider-neutral errors and never marks failed payloads transient', async () => {
    const [tool] = createGoogleMapsTools({
      callTool: vi.fn().mockRejectedValue(new Error('403 vendor secret details')),
    })
    const result = await tool.execute({ query: 'museum in Kyoto, Japan' }, context)

    expect(classifyGoogleMapsError(new Error('429 quota exceeded'))).toBe('rate_limited')
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('configuration_error')
    expect(String(result.data)).not.toContain('vendor secret details')
    expect(result.meta?.transientProviderContent).toBeUndefined()
  })
})
