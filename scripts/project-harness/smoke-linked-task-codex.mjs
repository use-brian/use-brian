#!/usr/bin/env node
// Minimal app-server stdio peer. Never runs a model or shell command.
import { createInterface } from 'node:readline'
const send = message => console.log(JSON.stringify(message))
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line)
  switch (method) {
    case 'initialize': send({ id, result: {} }); break
    case 'initialized': break
    case 'thread/start': send({ id, result: { thread: { id: 'fixture-thread' } } }); break
    case 'turn/start':
      send({ id, result: { turn: { id: 'fixture-turn' } } })
      send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } } })
      break
    default: throw new Error(`Unexpected app-server method: ${method}`)
  }
}
