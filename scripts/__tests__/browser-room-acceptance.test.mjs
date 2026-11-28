import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { createRoomFixture, verifyRoomEvents } from '../testing/browser-room-acceptance.mjs'

const search = { event: 'search', day: 'Next Thursday', time: '3:00 PM', people: 6 }
const paused = [{ event: 'results-tab' }, search, { event: 'detail', room: 'willow' }]
const finished = [...paused, { event: 'detail', room: 'birch' }, { event: 'detail', room: 'cedar' }]

test('release audit requires every comparison and no repeated search or booking', () => {
  assert.doesNotThrow(() => verifyRoomEvents('standard', finished))
  assert.doesNotThrow(() => verifyRoomEvents('paused', paused))
  assert.doesNotThrow(() => verifyRoomEvents('resumed', finished))
  assert.doesNotThrow(() => verifyRoomEvents('vague', []))
  for (const events of [
    [], paused, [...finished, search], [...finished, { event: 'results-tab' }],
    [...finished, { event: 'detail', room: 'willow' }], [...finished, { event: 'would-confirm' }],
    finished.map(event => event.event === 'search' ? { ...event, people: 8 } : event),
  ]) assert.throws(() => verifyRoomEvents('standard', events))
  assert.throws(() => verifyRoomEvents('vague', paused))
  assert.throws(() => verifyRoomEvents('unknown', []))
})

test('fixture serves real delayed results, links, and independent action evidence', async t => {
  const events = []
  const server = createRoomFixture({ onEvent: event => events.push(event), delayMs: 100 })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const base = `http://127.0.0.1:${server.address().port}`
  const landing = await (await fetch(base)).text()
  assert.match(landing, /aria-live="polite"/)
  assert.match(landing, /Checking availability…/)
  assert.match(landing, /await fetch/)
  const start = performance.now()
  const results = await (await fetch(`${base}/search?day=Next+Thursday&time=3%3A00+PM&people=6`)).text()
  assert.ok(performance.now() - start >= 80, 'results must really be asynchronous')
  for (const key of ['willow', 'birch', 'cedar']) {
    assert.match(results, new RegExp(`href="/room/${key}"`))
    const detail = await (await fetch(`${base}/room/${key}`)).text()
    assert.match(detail, /Confirm demo booking/)
    if (key === 'cedar') assert.match(detail, /Quiet \/ soundproof.*Room camera and microphone/)
  }
  verifyRoomEvents('standard', events)
  await fetch(`${base}/would-confirm`, { method: 'POST' })
  assert.throws(() => verifyRoomEvents('standard', events), /booking/)
})
