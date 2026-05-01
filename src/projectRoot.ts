import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_MARKERS = ['pnpm-workspace.yaml']

function findProjectRoot(start: string): string {
  let dir = start
  while (true) {
    if (ROOT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error(
        `[projectRoot] Cannot locate project root (no ${ROOT_MARKERS.join(' / ')}) starting from ${start}`,
      )
    }
    dir = parent
  }
}

export const projectRoot: string = findProjectRoot(path.dirname(fileURLToPath(import.meta.url)))
