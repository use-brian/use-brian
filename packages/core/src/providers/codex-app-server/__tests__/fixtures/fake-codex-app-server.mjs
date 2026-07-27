import readline from 'node:readline'

process.stderr.write('fake-diagnostic-output-that-must-be-bounded')

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize' && message.id !== undefined) {
    process.stdout.write(
      `${JSON.stringify({
        id: message.id,
        result: {
          codexHome: process.env.CODEX_HOME,
          platformFamily: 'test',
          platformOs: process.cwd(),
          userAgent: 'fake-codex-app-server',
        },
      })}\n`,
    )
    return
  }
  if (message.method === 'account/read' && message.id !== undefined) {
    process.stdout.write(
      `${JSON.stringify({
        id: message.id,
        result: {
          account: null,
          requiresOpenaiAuth: true,
        },
      })}\n`,
    )
    return
  }
  if (message.method === 'model/list' && message.id !== undefined) {
    process.stdout.write(
      `${JSON.stringify({
        id: message.id,
        result: {
          data: [],
          nextCursor: null,
        },
      })}\n`,
    )
  }
})
