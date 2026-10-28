import type { AppUpdater } from 'electron-updater'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider'
import { parseUpdateInfo, type ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'

export const UPDATE_REPOSITORY = { owner: 'wenshen18643', repo: 'myclipper' } as const

const RELEASE_SCAN_LIMIT = 30

interface ReleaseListing {
  tag_name?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: { name?: unknown }[]
}

function versionOf(tag: string): number[] | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)
  return match ? match.slice(1).map(Number) : null
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

export function newestReleaseWith(releases: unknown, channelFile: string): string | null {
  if (!Array.isArray(releases)) return null
  let best: { tag: string; version: number[] } | null = null
  for (const release of releases as ReleaseListing[]) {
    if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string') continue
    const version = versionOf(release.tag_name)
    if (!version || !Array.isArray(release.assets) || !release.assets.some((asset) => asset.name === channelFile)) continue
    if (!best || newer(version, best.version)) best = { tag: release.tag_name, version }
  }
  return best?.tag ?? null
}

export class PlatformGitHubProvider extends GitHubProvider {
  constructor(_options: unknown, updater: AppUpdater, runtimeOptions: ProviderRuntimeOptions) {
    super({ provider: 'github', ...UPDATE_REPOSITORY }, updater, runtimeOptions)
  }

  async getLatestVersion(): ReturnType<GitHubProvider['getLatestVersion']> {
    try {
      return await super.getLatestVersion()
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') throw error
      const channelFile = `${this.getDefaultChannelName()}.yml`
      const { owner, repo } = this.options
      const listing = await this.httpRequest(
        new URL(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=${RELEASE_SCAN_LIMIT}`),
        { accept: 'application/vnd.github+json' }
      )
      const tag = newestReleaseWith(listing ? JSON.parse(listing) : null, channelFile)
      if (!tag) throw error
      const channelFileUrl = new URL(`https://github.com/${owner}/${repo}/releases/download/${tag}/${channelFile}`)
      const info = parseUpdateInfo(await this.httpRequest(channelFileUrl), channelFile, channelFileUrl)
      if (info.version !== tag.slice(1)) throw error
      return { ...info, tag }
    }
  }
}
