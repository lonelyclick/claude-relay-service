import { main } from '../../../src/bootstrap/relayMain.js'

void main().catch((error) => {
  process.stderr.write(
    `[startup] error=${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  )
  process.exit(1)
})
