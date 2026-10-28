import { createHash } from 'crypto'
import { chmodSync, existsSync, lstatSync, readdirSync, renameSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'

const QUARANTINE_MS = 30 * 24 * 60 * 60_000

export function workspaceId(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function readableCache(path: string, maxBytes: number): boolean {
  try {
    const file = lstatSync(path)
    return file.isFile() && file.size <= maxBytes
  } catch { return false }
}

export function quarantineUnbound(path: string): void {
  const prefix = `${basename(path)}.quarantine-`
  try {
    for (const name of readdirSync(dirname(path))) {
      if (!name.startsWith(prefix)) continue
      const at = Number(name.slice(prefix.length))
      if (Number.isFinite(at) && Date.now() - at > QUARANTINE_MS) {
        
        rmSync(join(dirname(path), name), { force: true })
      }
    }
    if (existsSync(path)) {
      if (lstatSync(path).isFile()) chmodSync(path, 0o600)
      renameSync(path, `${path}.quarantine-${Date.now()}`)
    }
  } catch {  }
}
