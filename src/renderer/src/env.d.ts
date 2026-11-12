import type { Api } from '../../preload'

declare global {
  interface Window {
    api: Api
  }
}

declare module '*.css'

export {}
