import type { MyClipperAPI } from '../../preload/index'

declare global {
  interface Window {
    myclipper: MyClipperAPI
  }
}

export function getApi(): MyClipperAPI {
  return window.myclipper
}
