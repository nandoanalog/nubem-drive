export type FolderStatus = 'synced' | 'syncing' | 'queued' | 'paused' | 'conflict' | 'offline'
export type LocalMode = 'online' | 'local' | 'mirror'

export type CloudFolder = {
  id: string
  name: string
  path: string
  vaultRole?: PairingRole
  relayUrl?: string
  pairId?: string
  token?: string
  code?: string
  codeExpiresAt?: string
  storageName?: string
  sizeLabel: string
  itemCount: number
  updatedAt: string
  status: FolderStatus
  localMode: LocalMode
  devices: string[]
  progress: number
}

export type StorageNode = {
  name: string
  path: string
  status: 'online' | 'offline'
  relayStatus: 'ready' | 'offline' | 'limited' | 'waiting' | 'linked'
}

export type Device = {
  id: string
  name: string
  role: string
  status: 'online' | 'sleeping' | 'offline'
  address: string
}

export type PairingRole = 'storage' | 'client'
export type PairingStatus = 'idle' | 'ready' | 'waiting' | 'linked' | 'offline' | 'error'

export type PairingState = {
  relayUrl: string
  role: PairingRole | null
  status: PairingStatus
  pairCode?: string
  pairCodeExpiresAt?: string
  pairId?: string
  token?: string
  storageName?: string
  lastSeenAt?: string
  message?: string
}

export type UpdateStatus = 'idle' | 'current' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'

export type UpdateState = {
  currentVersion: string
  platform: string
  status: UpdateStatus
  latestVersion?: string
  checkedAt?: string
  message?: string
  downloadUrl?: string
  fileName?: string
  sha256?: string
  downloadedPath?: string
  progress?: number
}

export type RemoteEntry = {
  name: string
  type: 'directory' | 'file'
  relativePath: string
  sizeBytes: number
  sizeLabel: string
  modifiedAt: string
}

export type RemoteListing = {
  folderId: string
  path: string
  parentPath: string
  entries: RemoteEntry[]
}

export type RemoteDownloadResult = {
  ok: boolean
  filePath?: string
}

export type RemoteDeleteResult = {
  ok: boolean
  canceled?: boolean
  deleted?: {
    name: string
    relativePath: string
    type: 'file' | 'folder'
    deletedAt: string
  }
}

export type ActivityItem = {
  id: string
  type: 'upload' | 'pin' | 'relay' | 'pause' | 'link' | 'download' | 'remove' | 'vault'
  label: string
  detail: string
  at: string
}

export type SyncFile = {
  sourcePath: string
  relativePath: string
  sizeBytes: number
  modifiedAt: string
  status: 'pending' | 'done' | 'error'
  attempts: number
  uploadedBytes: number
  error: string
}

export type SyncJob = {
  id: string
  type: 'upload-folder'
  vaultFolderId: string
  rootPath: string
  rootName: string
  status: 'queued' | 'running' | 'complete' | 'error'
  createdAt: string
  updatedAt: string
  completedAt: string
  nextAttemptAt: string
  lastError: string
  totalFiles: number
  completedFiles: number
  totalBytes: number
  files: SyncFile[]
}

export type AppState = {
  appMode: 'client' | 'server'
  storageNode: StorageNode
  currentDevice: {
    id: string
    name: string
    platform: string
    status: 'online' | 'offline'
  }
  pairing: PairingState
  updates: UpdateState
  folders: CloudFolder[]
  devices: Device[]
  syncJobs: SyncJob[]
  activity: ActivityItem[]
}

export type NubemDriveApi = {
  getState: () => Promise<AppState>
  chooseFolders: () => Promise<AppState>
  cloudFolders: () => Promise<AppState>
  removeFolder: (id: string) => Promise<AppState>
  setFolderMode: (id: string, mode: LocalMode) => Promise<AppState>
  toggleFolderSync: (id: string) => Promise<AppState>
  revealFolder: (folderPath: string) => Promise<void>
  createPairCode: (relayUrl: string) => Promise<AppState>
  joinPairing: (relayUrl: string, code: string) => Promise<AppState>
  shareVault: (id: string, relayUrl: string) => Promise<AppState>
  renameVault: (id: string, name: string) => Promise<AppState>
  refreshPairing: () => Promise<AppState>
  resetPairing: () => Promise<AppState>
  setServerMode: (enabled: boolean) => Promise<AppState>
  browseRemoteFolder: (folderId: string, relativePath: string) => Promise<RemoteListing>
  downloadRemoteFile: (folderId: string, relativePath: string) => Promise<RemoteDownloadResult>
  deleteRemoteEntry: (folderId: string, relativePath: string) => Promise<RemoteDeleteResult>
  checkForUpdates: () => Promise<AppState>
  downloadUpdate: () => Promise<AppState>
  installUpdate: () => Promise<AppState>
}
