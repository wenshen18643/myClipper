import { execFile, spawn, type ChildProcess } from 'child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir, userInfo } from 'os'
import { delimiter, dirname, isAbsolute, join } from 'path'

const SHELL_PATH_TIMEOUT_MS = 3000
const PATH_MARKER = '__MYCLIPPER_PATH__'

let shellPathPromise: Promise<string | null> | null = null

export function loginShellPath(): Promise<string | null> {
  if (process.platform === 'win32') return Promise.resolve(null)
  shellPathPromise ??= new Promise((resolve) => {
    const configured = process.env.SHELL
    const shell = configured && isAbsolute(configured) && /\/(zsh|bash)$/.test(configured) && existsSync(configured)
      ? configured
      : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
    execFile(shell, ['-ilc', `printf '%s%s%s' '${PATH_MARKER}' "$PATH" '${PATH_MARKER}'`], {
      timeout: SHELL_PATH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: { HOME: homedir(), USER: process.env.USER ?? '', SHELL: shell, TERM: 'dumb', PATH: process.env.PATH ?? '' },
      windowsHide: true
    }, (_error, stdout) => {
      const match = String(stdout ?? '').match(new RegExp(`${PATH_MARKER}([^\\0]*?)${PATH_MARKER}`))
      resolve(match && match[1].trim() ? match[1].trim() : null)
    })
  })
  return shellPathPromise
}

function newestFirst(directory: string, suffix: string[]): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => /^v?\d/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => join(directory, name, ...suffix))
  } catch {
    return []
  }
}

export function wellKnownCliDirectories(home = homedir(), platform = process.platform): string[] {
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [
      join(home, '.local', 'bin'),
      join(appData, 'npm'),
      join(localAppData, 'Programs', 'claude'),
      join(localAppData, 'Microsoft', 'WinGet', 'Links'),
      join(home, 'scoop', 'shims'),
      join(home, '.bun', 'bin'),
      join(home, '.volta', 'bin')
    ]
  }
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.codex', 'bin'),
    join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, 'Library', 'pnpm'),
    join(home, '.local', 'share', 'pnpm'),
    join(home, '.asdf', 'shims'),
    join(home, '.local', 'share', 'mise', 'shims'),
    ...newestFirst(join(home, '.nvm', 'versions', 'node'), ['bin']),
    ...newestFirst(join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin']),
    ...newestFirst(join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), ['installation', 'bin']),
    '/usr/bin',
    '/bin'
  ]
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (process.platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function uniquePath(entries: string[]): string[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (!entry || !isAbsolute(entry) || seen.has(entry)) return false
    seen.add(entry)
    return true
  })
}

export interface ResolvedCli {
  command: string
  prefixArgs: string[]
  pathValue: string
}

function resolveWindowsShim(shim: string, pathEntries: string[]): ResolvedCli | null {
  try {
    const text = readFileSync(shim, 'utf8')
    const match = text.match(/"%~?dp0%?\\([^"]+\.js)"/i)
    if (!match) return null
    const script = join(dirname(shim), match[1])
    const localNode = join(dirname(shim), 'node.exe')
    const node = existsSync(localNode) ? localNode : pathEntries.map((entry) => join(entry, 'node.exe')).find(isExecutable)
    if (!node || !existsSync(script)) return null
    return { command: node, prefixArgs: [script], pathValue: pathEntries.join(delimiter) }
  } catch {
    return null
  }
}

export async function resolveCli(name: 'claude' | 'codex'): Promise<ResolvedCli | null> {
  const shellPath = await loginShellPath()
  const entries = uniquePath([
    ...(shellPath ?? '').split(delimiter),
    ...(process.env.PATH ?? '').split(delimiter),
    ...wellKnownCliDirectories()
  ])
  const pathValue = entries.join(delimiter)
  if (process.platform === 'win32') {
    for (const entry of entries) {
      const exe = join(entry, `${name}.exe`)
      if (isExecutable(exe)) return { command: exe, prefixArgs: [], pathValue }
      const shim = join(entry, `${name}.cmd`)
      if (existsSync(shim)) {
        const resolved = resolveWindowsShim(shim, entries)
        if (resolved) return resolved
      }
    }
    return null
  }
  for (const entry of entries) {
    const candidate = join(entry, name)
    if (isExecutable(candidate)) return { command: candidate, prefixArgs: [], pathValue }
  }
  return null
}

const INHERITED_ENV = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_GIT_BASH_PATH',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'ProgramFiles', 'ProgramFiles(x86)', 'HOMEDRIVE', 'HOMEPATH', 'COMPUTERNAME', 'USERNAME', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'OS'
]

export function cliEnvironment(pathValue: string, extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of INHERITED_ENV) {
    const value = source[key]
    if (typeof value === 'string' && value) env[key] = value
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('LC_') && typeof value === 'string') env[key] = value
  }
  if (!env.HOME) env.HOME = homedir()
  if (!env.USER) {
    try { env.USER = userInfo().username } catch {  }
  }
  env.PATH = pathValue
  env.TERM = 'dumb'
  env.NO_COLOR = '1'
  return { ...env, ...extra }
}

export interface CliRun {
  child: ChildProcess
  stop: () => void
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

const STOP_GRACE_MS = 1500
const TERMINATE_GRACE_MS = 750

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    if (signal === 'SIGINT') return
    execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {})
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch {  }
  }
}

const liveRuns = new Set<CliRun>()

export function spawnCli(cli: ResolvedCli, args: string[], options: { cwd: string; env: Record<string, string> }): CliRun {
  const child = spawn(cli.command, [...cli.prefixArgs, ...args], {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  let finished = false
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', () => { finished = true; resolve({ code: null, signal: null }) })
    child.once('close', (code, signal) => { finished = true; resolve({ code, signal }) })
  })
  let stopping = false
  const run: CliRun = {
    child,
    exited,
    stop: () => {
      if (stopping || finished) return
      stopping = true
      signalTree(child, 'SIGINT')
      setTimeout(() => {
        if (finished) return
        signalTree(child, 'SIGTERM')
        setTimeout(() => { if (!finished) signalTree(child, 'SIGKILL') }, TERMINATE_GRACE_MS)
      }, process.platform === 'win32' ? 0 : STOP_GRACE_MS)
    }
  }
  liveRuns.add(run)
  void exited.then(() => {
    liveRuns.delete(run)
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL') } catch {  }
    }
  })
  return run
}

export function stopAllCliRuns(): void {
  for (const run of liveRuns) {
    signalTree(run.child, 'SIGKILL')
  }
  liveRuns.clear()
}

export function runCliCommand(cli: ResolvedCli, args: string[], env: Record<string, string>, timeoutMs = 20000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cli.command, [...cli.prefixArgs, ...args], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? (error as unknown as { code: number }).code
        : error ? null : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}
