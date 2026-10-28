import { app, dialog, ipcMain, powerMonitor, shell, type BrowserWindow, type MessageBoxSyncOptions } from 'electron'
import { execFile } from 'child_process'
import { posix } from 'path'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import { REPO_URL } from '../shared/brand'
import {
  UPDATE_CHECK_DELAY_MS, UPDATE_CHECK_INTERVAL_MS, updateErrorMessage,
  type UpdateState, type UpdatesOffReason
} from '../shared/updates'
import { assertTrustedSender } from './security'
import { logger } from './logger'
import { PlatformGitHubProvider } from './update-provider'

const MAC_TEAM_ID = '9CBJCDR3J2'

let getWindow: () => BrowserWindow | null = () => null
let lastCheckedAt: string | null = null
let state: UpdateState = { status: 'idle', currentVersion: app.getVersion(), lastCheckedAt }
let checkInFlight: Promise<void> | null = null
let started: Promise<void> = Promise.resolve()

function publish(next: UpdateState): void {
  state = next
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('update:state', state)
}

function base(): { currentVersion: string; lastCheckedAt: string | null } {
  return { currentVersion: app.getVersion(), lastCheckedAt }
}

function errorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : ''
}

function macBundlePath(): string {
  return posix.resolve(app.getPath('exe'), '..', '..', '..')
}

function signedByBridgeMind(): Promise<boolean> {
  return new Promise((done) => {
    execFile('/usr/bin/codesign', ['--display', '--verbose=2', macBundlePath()], { timeout: 10_000 }, (error, _stdout, stderr) => {
      done(!error && new RegExp(`^TeamIdentifier=${MAC_TEAM_ID}$`, 'm').test(stderr) && /^Authority=Developer ID Application: /m.test(stderr))
    })
  })
}

async function updatesOffReason(): Promise<UpdatesOffReason | null> {
  if (process.env.MYCLIPPER_DISABLE_AUTO_UPDATE === '1') return 'disabled'
  if (is.dev || !app.isPackaged) return 'development'
  if (process.platform === 'darwin') {
    if (!(await signedByBridgeMind())) return 'unofficial'
    const bundle = macBundlePath()
    if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return 'move-to-applications'
  }
  return null
}

async function check(trigger: 'scheduled' | 'user' | 'resume' | 'menu'): Promise<void> {
  await started
  if (state.status === 'off' || state.status === 'downloading' || state.status === 'ready') return
  if (checkInFlight) return checkInFlight
  logger.info('update.check', { trigger })
  publish({ ...base(), status: 'checking' })
  checkInFlight = autoUpdater.checkForUpdates()
    .then((result) => {
      result?.downloadPromise?.catch(() => {})
    })
    .catch(() => {  })
    .finally(() => {
      checkInFlight = null
      lastCheckedAt = new Date().toISOString()
      publish(state.status === 'checking' ? { ...base(), status: 'idle' } : { ...state, lastCheckedAt })
    })
  return checkInFlight
}

function registerIpc(): void {
  const handle: typeof ipcMain.handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event, getWindow())
    return listener(event, ...args)
  })
  handle('update:getState', () => state)
  handle('update:check', async () => {
    await check('user')
    return state
  })
  handle('update:install', () => {
    if (state.status !== 'ready') throw new Error('No update is ready to install.')
    logger.info('update.install', { version: state.version })
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return true
  })
  handle('update:moveToApplications', () => {
    if (process.platform !== 'darwin' || state.status !== 'off' || state.reason !== 'move-to-applications') return false
    try {
      return app.moveToApplicationsFolder({
        conflictHandler: (conflict) => {
          if (conflict === 'existsAndRunning') return false
          const options: MessageBoxSyncOptions = {
            type: 'question',
            buttons: ['Replace', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            message: 'Replace the myClipper in your Applications folder?',
            detail: 'Applications already has a copy of myClipper. Replacing it moves that copy to the Trash.'
          }
          const window = getWindow()
          return (window ? dialog.showMessageBoxSync(window, options) : dialog.showMessageBoxSync(options)) === 0
        }
      })
    } catch (error) {
      logger.warn('update.move_failed', { code: errorCode(error) })
      return false
    }
  })
  handle('update:openReleaseNotes', async () => {
    const version = state.status === 'downloading' || state.status === 'ready' ? state.version : state.currentVersion
    if (!/^\d+\.\d+\.\d+$/.test(version)) return false
    await shell.openExternal(`${REPO_URL}/releases/tag/v${version}`)
    return true
  })
}

async function start(): Promise<void> {
  const reason = await updatesOffReason()
  if (reason) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    logger.info('update.off', { reason })
    publish({ ...base(), status: 'off', reason })
    return
  }

  autoUpdater.setFeedURL({ provider: 'custom', updateProvider: PlatformGitHubProvider })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false

  autoUpdater.on('update-available', (info) => {
    logger.info('update.available', { version: info.version })
    publish({ ...base(), status: 'downloading', version: info.version, progress: null })
  })
  autoUpdater.on('update-not-available', () => {
    publish({ ...base(), status: 'up-to-date' })
  })
  autoUpdater.on('download-progress', (progress) => {
    if (state.status !== 'downloading') return
    publish({
      ...state,
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      }
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    logger.info('update.ready', { version: info.version })
    publish({ ...base(), status: 'ready', version: info.version })
  })
  autoUpdater.on('error', (error) => {
    const httpStatus = error && typeof error === 'object' && 'statusCode' in error ? Number((error as { statusCode: unknown }).statusCode) : null
    logger.warn('update.failed', { code: errorCode(error), httpStatus, during: state.status })
    publish({ ...base(), status: 'error', message: updateErrorMessage(error) })
  })

  setTimeout(() => void check('scheduled'), UPDATE_CHECK_DELAY_MS)
  setInterval(() => void check('scheduled'), UPDATE_CHECK_INTERVAL_MS)
  powerMonitor.on('resume', () => {
    if (!lastCheckedAt || Date.now() - Date.parse(lastCheckedAt) > UPDATE_CHECK_INTERVAL_MS) void check('resume')
  })
}

export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  getWindow = getMainWindow
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  registerIpc()
  started = start()
}

export function checkForUpdatesFromMenu(): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.webContents.send('update:show')
  }
  void check('menu')
}
