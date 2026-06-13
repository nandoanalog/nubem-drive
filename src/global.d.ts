import type { NubemDriveApi } from './types'

declare global {
  interface Window {
    nubemDrive?: NubemDriveApi
  }
}

export {}
