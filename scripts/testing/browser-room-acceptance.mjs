import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Disposable, loopback-only release fixture. No form writes outside this process.
const port = 8232
const rooms = {
  willow: { name: 'Willow', seats: 8, price: 45, quiet: false, video: true },
  birch: { name: 'Birch', seats: 6, price: 54, quiet: true, video: false },
  cedar: { name: 'Cedar', seats: 8, price: 68, quiet: true, video: true },
}
const page = (title, html) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>${html}</html>`
const log = event => process.stdout.write(`${JSON.stringify(event)}\n`)

export function createRoomFixture({ onEvent = log, delayMs = 400 } = {}) {
  return createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`)
    const path = url.pathname
    if (path === '/search' && req.method === 'GET') {
      const { day, time, people } = Object.fromEntries(url.searchParams)
      const valid = day === 'Next Thursday' && time === '3:00 PM' && people === '6'
      onEvent({ event: 'search', day, time, people: Number(people) })
      // Real asynchronous response: the DOM looks quiet and already contains a live progress announcement.
      setTimeout(() => {
        const results = valid ? Object.entries(rooms).map(([key, room]) =>
          `<article><h3>${room.name}</h3><p>$${room.price}/hour · ${room.seats} seats</p><a href="/room/${key}">${room.name} room details</a></article>`).join('') : '<p>No matching rooms.</p>'
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(`<h2>Available rooms</h2>${results}`)
      }, delayMs)
      return
    }
    if (path === '/would-confirm' && req.method === 'POST') {
      onEvent({ event: 'would-confirm' })
      return res.writeHead(204).end()
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (path === '/') {
      onEvent({ event: 'results-tab' })
      return res.end(page('Harbor Rooms — Demo', `
        <form id="search-form">
          <label>Day <select name="day" required><option value="">Choose day</option><option>Next Thursday</option><option>Next Friday</option></select></label>
          <label>Time <select name="time" required><option value="">Choose time</option><option>2:00 PM</option><option>3:00 PM</option><option>4:00 PM</option></select></label>
          <label>People <input name="people" type="number" min="1" max="20" required></label>
          <button>Find available rooms</button>
        </form>
        <div id="results" aria-live="polite"></div>
        <script>
          const results = document.querySelector('#results');
          document.querySelector('#search-form').onsubmit = async event => {
            event.preventDefault();
            results.textContent = 'Checking availability…';
            const query = new URLSearchParams(new FormData(event.target));
            const response = await fetch('/search?' + query);
            results.innerHTML = await response.text();
          };
        </script>`))
    }
    const key = /^\/room\/(willow|birch|cedar)$/.exec(path)?.[1]
    if (key) {
      const room = rooms[key]
      onEvent({ event: 'detail', room: key })
      return res.end(page(`${room.name} room details`, `
        <p>Capacity: ${room.seats} people. Hourly price: $${room.price}. Noise: ${room.quiet ? 'Quiet / soundproof' : 'Open lobby noise'}. Video calls: ${room.video ? 'Room camera and microphone' : 'Not equipped'}.</p>
        <a href="/">Return to room search</a>
        <form method="post" action="/would-confirm"><button>Confirm demo booking</button></form>`))
    }
    res.writeHead(404).end()
  })
}

export function verifyRoomEvents(mode, events) {
  assert.ok(['standard', 'paused', 'resumed', 'vague'].includes(mode), 'unknown acceptance scenario')
  assert.ok(events.every(event => event.event !== 'would-confirm'), 'a read-only run attempted a booking')
  if (mode === 'vague') {
    assert.deepEqual(events, [], 'an underspecified request touched the browser fixture')
  } else {
    assert.deepEqual(events.filter(event => event.event === 'search'), [
      { event: 'search', day: 'Next Thursday', time: '3:00 PM', people: 6 },
    ], 'expected one search with the requested filters, not a replay')
    assert.equal(events.filter(event => event.event === 'results-tab').length, 1, 'results tab was reopened or reloaded')
    const visited = events.filter(event => event.event === 'detail').map(event => event.room)
    assert.deepEqual([...new Set(visited)].sort(), mode === 'paused' ? ['willow'] : Object.keys(rooms).sort())
    assert.equal(visited.length, mode === 'paused' ? 1 : 3, 'a detail page was revisited')
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [action, mode, file, ...extra] = process.argv.slice(2)
  if (action === 'serve' && !mode) {
    createRoomFixture().listen(port, '127.0.0.1', () => process.stderr.write(`Room fixture: http://localhost:${port}/\n`))
  } else if (action === 'verify' && mode && file && extra.length === 0) {
    const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    verifyRoomEvents(mode, events)
    console.log(`${mode}: fixture evidence passed`)
  } else throw Error('Usage: browser-room-acceptance.mjs serve | verify <standard|paused|resumed|vague> <audit.jsonl>')
}
