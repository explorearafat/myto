import type { MytoApi } from '@shared/types'
import 'react'

declare global {
  interface Window {
    myto: MytoApi
  }
}

// Allow the Electron-only `-webkit-app-region` value in inline styles without casts.
declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag'
  }
}

export {}
