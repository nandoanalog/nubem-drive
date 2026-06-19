export type FolderStatus = 'synced' | 'syncing' | 'queued' | 'paused' | 'conflict' | 'offline'
export type LocalMode = 'online' | 'local' | 'mirror'

export type ClientVault = {
  name: string
  clientName: string
  remotePathPrefix: string
  status: 'online' | 'sleeping' | 'offline'
  lastSeenAt?: string
}

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
  remotePathPrefix?: string
  storageName?: string
  sizeBytes?: number
  sizeLabel: string
  itemCount: number
  updatedAt: string
  status: FolderStatus
  localMode: LocalMode
  devices: string[]
  clientVaults?: ClientVault[]
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

export type ShareLinkResult = {
  ok: boolean
  token: string
  url: string
  name: string
  type: 'file' | 'directory'
  relativePath: string
  expiresAt: string
  maxDownloads: number
  downloadCount: number
}

export type ActivityItem = {
  id: string
  type: 'upload' | 'pin' | 'relay' | 'pause' | 'link' | 'download' | 'remove' | 'vault'
  label: string
  detail: string
  at: string
}

export type TrafficTransfer = {
  id: string
  direction: 'upload' | 'download'
  vaultId: string
  vaultName: string
  clientName: string
  fileName: string
  relativePath: string
  totalBytes: number
  transferredBytes: number
  rateBytesPerSecond: number
  startedAt: string
  updatedAt: string
}

export type TrafficState = {
  updatedAt: string
  uploadBytesPerSecond: number
  downloadBytesPerSecond: number
  active: TrafficTransfer[]
}

export type VpsQueueItem = {
  id: string
  type: 'upload' | 'download'
  status: 'uploading' | 'pending' | 'ready'
  stage: 'client-to-vps' | 'waiting-server' | 'server-to-vps' | 'vps-to-server' | 'waiting-client' | 'vps-to-client' | 'ready'
  stageLabel: string
  vaultName: string
  clientName: string
  fileName: string
  relativePath: string
  bytes: number
  transferredBytes: number
  totalBytes: number
  createdAt: string
  updatedAt: string
}

export type VpsStats = {
  updatedAt: string
  traffic: {
    inboundBytesPerSecond: number
    outboundBytesPerSecond: number
  }
  queue: {
    files: number
    bytes: number
    doneFiles: number
    doneBytes: number
    totalFiles: number
    totalBytes: number
    oldestAt: string
    stages: {
      clientToVps: number
      waitingServer: number
      serverToVps: number
      vpsToServer: number
      waitingClient: number
      vpsToClient: number
      done: number
    }
    items: VpsQueueItem[]
  }
  storage: {
    usedBytes: number
    freeBytes: number
    totalBytes: number
    usedPercent: number
  }
}

export type SyncFile = {
  sourcePath: string
  relativePath: string
  sizeBytes: number
  modifiedAt: string
  status: 'pending' | 'uploading' | 'done' | 'error'
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
  scanStatus: 'queued' | 'scanning' | 'complete'
  queuePath: string
  queueCursor: number
  scanPendingDirs: Array<{
    path: string
    entriesPath: string
    offset: number
  }>
  createdAt: string
  updatedAt: string
  completedAt: string
  nextAttemptAt: string
  lastError: string
  totalFiles: number
  completedFiles: number
  completedBytes: number
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
  traffic: TrafficState
  vpsStats: VpsStats
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
  createShareLink: (folderId: string, relativePath: string, type: RemoteEntry['type'], name: string) => Promise<ShareLinkResult>
  cancelSyncJob: (jobId: string) => Promise<AppState>
  copyText: (text: string) => Promise<{ ok: boolean }>
  checkForUpdates: () => Promise<AppState>
  downloadUpdate: () => Promise<AppState>
  installUpdate: () => Promise<AppState>
}
