export type FolderStatus = 'synced' | 'syncing' | 'queued' | 'paused' | 'conflict' | 'offline'
export type LocalMode = 'online' | 'local' | 'mirror'

export type CloudFolder = {
  id: string
  name: string
  path: string
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
  capacityBytes: number
  usedBytes: number
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

export type ActivityItem = {
  id: string
  type: 'upload' | 'pin' | 'relay' | 'pause' | 'link' | 'download'
  label: string
  detail: string
  at: string
}

export type AppState = {
  storageNode: StorageNode
  currentDevice: {
    id: string
    name: string
    platform: string
    status: 'online' | 'offline'
  }
  pairing: PairingState
  folders: CloudFolder[]
  devices: Device[]
  activity: ActivityItem[]
}

export type NubemDriveApi = {
  getState: () => Promise<AppState>
  chooseFolders: () => Promise<AppState>
  setFolderMode: (id: string, mode: LocalMode) => Promise<AppState>
  toggleFolderSync: (id: string) => Promise<AppState>
  revealFolder: (folderPath: string) => Promise<void>
  createPairCode: (relayUrl: string) => Promise<AppState>
  joinPairing: (relayUrl: string, code: string) => Promise<AppState>
  refreshPairing: () => Promise<AppState>
  resetPairing: () => Promise<AppState>
  browseRemoteFolder: (folderId: string, relativePath: string) => Promise<RemoteListing>
  downloadRemoteFile: (folderId: string, relativePath: string) => Promise<RemoteDownloadResult>
}
