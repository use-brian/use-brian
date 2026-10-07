import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../db/client.js', () => ({ query: vi.fn() }))
import { query } from '../db/client.js'
import { nativeComputerRoutes } from '../routes/native-computer.js'
import { createNativeComputerService } from './boot-service.js'

const config = {
  relayUrl: 'https://relay.example', relaySecret: 'test-relay-secret',
  jwtSecret: 'test-jwt-secret', deploymentId: 'test-deployment',
}
const id = '00000000-0000-4000-8000-000000000001'
const connectionId = '00000000-0000-4000-8000-000000000002'

describe('[COMP:api/native-service-bootstrap]', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks() })

  it.each([undefined, 'false', 'true'])('connects a configured profile with legacy API flag %s', async flag => {
    vi.stubEnv('NATIVE_COMPUTER_ENABLED', flag)
    const service = createNativeComputerService(config)
    expect(service).not.toBeNull()
    expect(query).not.toHaveBeenCalled()
    const connect = vi.spyOn(service!.profiles, 'connect').mockResolvedValue({ connectionId })
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => { req.userId = 'owner'; req.authSessionId = 'desktop-auth'; next() })
    app.use(nativeComputerRoutes(service))
    const path = `/profiles/${id}/connect`
    const body = { workspaceId: id, deviceId: 'device' }
    expect((await request(app).post(path).send(body)).body).toEqual({ connectionId })
    expect(connect).toHaveBeenCalledExactlyOnceWith('owner', 'desktop-auth', id, id, 'device')
    for (const header of ['Origin', 'Sec-Fetch-Site']) {
      expect((await request(app).post(path).set(header, header === 'Origin' ? 'https://renderer.example' : 'same-origin').send(body)).status).toBe(403)
    }
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it.each(['relayUrl', 'relaySecret', 'deploymentId'] as const)('refuses missing %s before any I/O', key => {
    for (const value of [undefined, '']) {
      expect(createNativeComputerService({ ...config, [key]: value })).toBeNull()
    }
    expect(query).not.toHaveBeenCalled()
  })

  it('still requires an authenticated desktop session when transport is configured', async () => {
    const service = createNativeComputerService(config)!
    const connect = vi.spyOn(service.profiles, 'connect')
    const app = express()
    app.use(express.json())
    app.use(nativeComputerRoutes(service))
    expect((await request(app).post(`/profiles/${id}/connect`).send({ workspaceId: id, deviceId: 'device' })).status).toBe(403)
    expect(connect).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })
})
