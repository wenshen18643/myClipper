'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../../..')

function playwright() {
  for (const base of [process.env.MYCLIPPER_E2E_TOOLS, ROOT].filter(Boolean)) {
    try {
      return require(require.resolve('playwright-core', { paths: [base] }))
    } catch {  }
  }
  throw new Error('playwright-core not found. Install it outside the repo and set MYCLIPPER_E2E_TOOLS to that folder.')
}

function buildApp(appDir = process.env.MYCLIPPER_E2E_APP_DIR || path.join(os.tmpdir(), 'myclipper-e2e-app'), { skipBuild = process.env.MYCLIPPER_E2E_SKIP_BUILD === '1' } = {}) {
  fs.mkdirSync(appDir, { recursive: true })
  if (!skipBuild || !fs.existsSync(path.join(appDir, 'out/main/index.js'))) {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    execFileSync(npx, ['electron-vite', 'build', '--outDir', path.join(appDir, 'out')], { cwd: ROOT, stdio: 'inherit' })
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: 'out/main/index.js' }, null, 2))
  const modules = path.join(appDir, 'node_modules')
  if (!fs.existsSync(modules)) fs.symlinkSync(path.join(ROOT, 'node_modules'), modules, 'junction')
  return appDir
}

async function launchApp({ appDir, userDataDir, mock, apiUrl, env = {} }) {
  const main = fs.readFileSync(path.join(appDir, 'out/main/index.js'), 'utf8')
  if (!main.includes('isolated-appData') && !main.includes('isolated-${')) {
    throw new Error('This build predates full userData isolation; rebuild before launching it.')
  }
  const settingsFile = path.join(userDataDir, 'settings.json')
  const outputDirectory = path.join(userDataDir, 'myClipper')
  if (!fs.existsSync(settingsFile)) {
    fs.mkdirSync(userDataDir, { recursive: true })
    fs.writeFileSync(settingsFile, JSON.stringify({ version: 6, openrouterApiKey: '', zernioApiKey: '', outputDirectory, pythonPath: 'python3',  }), { mode: 0o600 })
  }
  const { _electron } = playwright()
  const electronPath = require(path.join(ROOT, 'node_modules/electron'))
  const cleanEnv = { ...process.env }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MYCLIPPER_ZERNIO_API_URL', 'MYCLIPPER_E2E_BROWSER_URL']) delete cleanEnv[name]
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [appDir, '--use-mock-keychain'],
    env: {
      ...cleanEnv,
      ...env,
      ...(mock || apiUrl ? { MYCLIPPER_ZERNIO_API_URL: apiUrl ?? mock.apiUrl } : {}),
      ...(mock ? { MYCLIPPER_E2E_BROWSER_URL: mock.browserUrl } : {}),
      MYCLIPPER_USER_DATA_DIR: userDataDir,
      MYCLIPPER_E2E: '1'
    },
    timeout: 60_000
  })
  const paths = await app.evaluate(({ app: electronApp }) => ['userData', 'appData', 'home', 'logs'].map((name) => [name, electronApp.getPath(name)]))
  const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
  const root = real(userDataDir)
  const outside = paths.filter(([, p]) => !real(p).startsWith(root)).map(([name, p]) => `${name}=${p}`)
  if (outside.length > 0) {
    await app.close().catch(() => {})
    throw new Error(`The test app is not isolated from ${userDataDir}: ${outside.join(', ')}`)
  }
  const page = await app.firstWindow()
  if (process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true') {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.webContents.setBackgroundThrottling(false)
      window.show()
    })
  }
  await page.waitForLoadState('domcontentloaded')
  const settings = await page.evaluate(() => window.myclipper.settings.load())
  if (!real(settings.outputDirectory).startsWith(root) && !path.resolve(settings.outputDirectory).startsWith(path.resolve(userDataDir))) {
    await app.close().catch(() => {})
    throw new Error(`The test app's output folder is outside ${userDataDir}.`)
  }
  return { app, page, close: () => app.close().catch(() => {}) }
}

module.exports = { buildApp, launchApp, ROOT }
