import { getApi } from './ipc'

const cache = new Map<string, Promise<string | null>>()
let tail: Promise<unknown> = Promise.resolve()

export function loadThumbnail(videoPath: string, seekSeconds?: number): Promise<string | null> {
  const cached = cache.get(videoPath)
  if (cached) return cached

  const task = tail
    .then(() => getApi().thumbnails.generate(videoPath, seekSeconds))
    .catch(() => null)
    .then((result) => {
      if (!result) cache.delete(videoPath)
      return result
    })
  tail = task
  cache.set(videoPath, task)
  return task
}

export function clipFilePath(url: string): string {
  return url.startsWith('file://') ? url.slice('file://'.length) : url
}
