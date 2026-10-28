import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export function resolveBinary(name: 'ffmpeg' | 'ffprobe' | 'yt-dlp'): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  if (!app.isPackaged && name === 'yt-dlp') {
    const venvTool = join(__dirname, '..', '..', 'engine', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', exe)
    if (existsSync(venvTool)) return venvTool
  }
  const binDir = app.isPackaged
    ? join(process.resourcesPath, 'engine-bin')
    : join(__dirname, '..', '..', 'engine-bin')
  const bundled = join(binDir, exe)
  if (app.isPackaged || existsSync(bundled)) return bundled
  return name
}

export async function supportsCaptionFilter(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(resolveBinary('ffmpeg'), ['-hide_banner', '-filters'], {
      timeout: 10000,
      maxBuffer: 1024 * 1024
    })
    return stdout.split('\n').some((line) => /^\s*[A-Z.]{2,}\s+ass\s/.test(line))
  } catch {
    return false
  }
}
