import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Laptop,
  Pause,
  Plus,
  RefreshCcw,
  Search,
  Share2,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import './App.css'
import type { AppState, CloudFolder, FolderStatus, RemoteEntry, RemoteListing, ShareLinkResult, SyncJob, TrafficTransfer, VpsQueueItem, VpsStats } from './types'

type FilterKey = 'all' | 'local' | 'online' | 'syncing'
type PairBusy = 'retry' | null
type RemoteSortKey = 'name' | 'modified' | 'size'
type SortDirection = 'asc' | 'desc'
type ShareDialogState = {
  busy: boolean
  copied: boolean
  entry: RemoteEntry
  error: string
  share: ShareLinkResult | null
} | null
type RemoteProgressStatus = 'synced' | 'uploading' | 'queued' | 'error'
type RemoteRowProgress = {
  detail: string
  label: string
  percent: number
  status: RemoteProgressStatus
}
type RemoteBrowserRow = RemoteEntry & {
  localPath?: string
  progress: RemoteRowProgress
  syncJobId?: string
  virtual?: boolean
}

const defaultRelayHost = 'drive.nubem.org'

const demoState: AppState = {
  appMode: 'client',
  storageNode: {
    name: 'Main storage',
    path: '/mnt/nubem-storage',
    status: 'online',
    relayStatus: 'ready',
  },
  currentDevice: {
    id: 'demo-device',
    name: 'This PC',
    platform: 'linux',
    status: 'online',
  },
  pairing: {
    relayUrl: `https://${defaultRelayHost}`,
    role: 'client',
    status: 'idle',
  },
  updates: {
    currentVersion: '0.0.0',
    platform: 'demo',
    status: 'idle',
  },
  folders: [],
  devices: [
    { id: 'demo-device', name: 'This PC', role: 'Client', status: 'online', address: 'Local' },
  ],
  traffic: {
    updatedAt: '',
    uploadBytesPerSecond: 0,
    downloadBytesPerSecond: 0,
    active: [],
  },
  vpsStats: {
    updatedAt: '',
    traffic: {
      inboundBytesPerSecond: 0,
      outboundBytesPerSecond: 0,
    },
    queue: {
      files: 0,
      bytes: 0,
      doneFiles: 0,
      doneBytes: 0,
      totalFiles: 0,
      totalBytes: 0,
      oldestAt: '',
      stages: {
        clientToVps: 0,
        waitingServer: 0,
        serverToVps: 0,
        vpsToServer: 0,
        waitingClient: 0,
        vpsToClient: 0,
        done: 0,
      },
      items: [],
    },
    storage: {
      usedBytes: 0,
      freeBytes: 0,
      totalBytes: 0,
      usedPercent: 0,
    },
  },
  syncJobs: [],
  activity: [],
}

const filters: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'local', label: 'Local' },
  { key: 'online', label: 'Online' },
  { key: 'syncing', label: 'Syncing' },
]

const filterIcons: Record<FilterKey, typeof Cloud> = {
  all: Folder,
  local: Download,
  online: Cloud,
  syncing: RefreshCcw,
}

const statusCopy: Record<FolderStatus, string> = {
  synced: 'Synced',
  syncing: 'Syncing',
  queued: 'Queued',
  paused: 'Paused',
  conflict: 'Conflict',
  offline: 'Offline',
}

type ConnectionTone = 'connected' | 'connecting' | 'waiting' | 'error' | 'offline' | 'idle'
type ConnectionSummary = {
  actionLabel?: string
  detail: string
  icon: typeof Cloud
  title: string
  tone: ConnectionTone
}

function clientVaults(state: AppState) {
  return state.folders.filter((folder) => folder.vaultRole === 'client' && folder.pairId && folder.token)
}

function connectionSummary(state: AppState, busy: PairBusy = null, error = ''): ConnectionSummary {
  if (busy === 'retry') {
    return {
      actionLabel: 'Retry now',
      detail: 'Looking for your Nubem Server',
      icon: RefreshCcw,
      title: 'Connecting to Nubem',
      tone: 'connecting',
    }
  }

  if (error) {
    return {
      actionLabel: 'Retry now',
      detail: error,
      icon: AlertTriangle,
      title: 'Connection failed',
      tone: 'error',
    }
  }

  const joinedVaults = clientVaults(state)
  if (joinedVaults.length > 0) {
    const vaultLabel = joinedVaults[0].name
    if (state.pairing.status === 'error' || state.pairing.status === 'offline') {
      return {
        actionLabel: 'Retry now',
        detail: 'Retrying automatically',
        icon: RefreshCcw,
        title: 'Reconnecting to Nubem',
        tone: 'connecting',
      }
    }

    return {
      detail: `Vault: ${vaultLabel}`,
      icon: CheckCircle2,
      title: 'Connected to Nubem',
      tone: 'connected',
    }
  }

  if (state.pairing.status === 'error') {
    return {
      actionLabel: 'Retry now',
      detail: state.pairing.message || 'Retrying automatically',
      icon: RefreshCcw,
      title: 'Waiting for Nubem Server',
      tone: 'waiting',
    }
  }

  if (state.pairing.role === 'storage') {
    const storageReady = state.storageNode.status === 'online'
    return {
      actionLabel: 'Add storage',
      detail: storageReady ? 'Choose drives or folders to use for cloud storage' : 'Storage service is not online',
      icon: HardDrive,
      title: storageReady ? 'Storage PC ready' : 'Storage PC offline',
      tone: storageReady ? 'waiting' : 'offline',
    }
  }

  return {
    actionLabel: 'Retry now',
    detail: 'Waiting for Nubem Server',
    icon: RefreshCcw,
    title: 'Connecting to Nubem',
    tone: 'connecting',
  }
}

function roleBadge(state: AppState) {
  if (state.appMode === 'server') {
    return { label: 'Server', title: 'Server app', className: 'server' }
  }

  return { label: 'Client', title: 'Client app', className: 'client' }
}

const statusIcons: Record<FolderStatus, typeof Cloud> = {
  synced: CheckCircle2,
  syncing: RefreshCcw,
  queued: UploadCloud,
  paused: Pause,
  conflict: AlertTriangle,
  offline: Cloud,
}

const visibleUpdateStatuses = new Set(['available', 'downloading', 'ready', 'installing', 'error'])

function updateTitle(state: AppState) {
  const latest = state.updates.latestVersion ? ` ${state.updates.latestVersion}` : ''
  if (state.updates.status === 'ready') return `Install update${latest}`
  if (state.updates.status === 'available') return `Download update${latest}`
  if (state.updates.status === 'downloading') return 'Downloading update'
  if (state.updates.status === 'installing') return 'Installing update'
  return state.updates.message || 'Check for updates'
}

function versionTitle(state: AppState) {
  const latest = state.updates.latestVersion
  if (latest && latest !== state.updates.currentVersion) {
    return `Installed ${state.updates.currentVersion}, latest ${latest}`
  }

  return `Installed ${state.updates.currentVersion}`
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function normalizeVaultPath(value = '') {
  return value.replace(/\\/g, '/').split('/').filter(Boolean).join('/')
}

function joinVaultPath(...parts: string[]) {
  return parts.map((part) => normalizeVaultPath(part)).filter(Boolean).join('/')
}

function baseName(value: string) {
  const parts = normalizeVaultPath(value).split('/').filter(Boolean)
  return parts[parts.length - 1] || value
}

function childPathForListing(currentPath: string, targetPath: string) {
  const current = normalizeVaultPath(currentPath)
  const target = normalizeVaultPath(targetPath)
  if (!target) return ''
  if (current && target !== current && !target.startsWith(`${current}/`)) return ''

  const remaining = current ? target.slice(current.length).replace(/^\/+/, '') : target
  const child = remaining.split('/').filter(Boolean)[0]
  return child ? joinVaultPath(current, child) : ''
}

function uploadRatio(file: SyncJob['files'][number]) {
  if (file.status === 'done') return 1
  if (file.sizeBytes <= 0) return file.uploadedBytes > 0 ? 1 : 0
  return Math.min(Math.max(file.uploadedBytes / file.sizeBytes, 0), 1)
}

function filesForVaultPath(jobs: SyncJob[], relativePath: string, type: RemoteEntry['type']) {
  const path = normalizeVaultPath(relativePath)
  return jobs.flatMap((job) =>
    job.files.filter((file) => {
      const filePath = normalizeVaultPath(file.relativePath)
      return type === 'directory' ? filePath === path || filePath.startsWith(`${path}/`) : filePath === path
    })
  )
}

function syncJobForVaultPath(jobs: SyncJob[], relativePath: string) {
  const path = normalizeVaultPath(relativePath)
  return jobs.find((job) => {
    const rootName = normalizeVaultPath(job.rootName)
    return path === rootName || path.startsWith(`${rootName}/`)
  })
}

function progressForVaultPath(
  jobs: SyncJob[],
  relativePath: string,
  type: RemoteEntry['type'],
  hasRemoteEntry: boolean
): RemoteRowProgress {
  const files = filesForVaultPath(jobs, relativePath, type)
  const job = syncJobForVaultPath(jobs, relativePath)
  if (files.length === 0) {
    if (job && job.status !== 'complete') {
      const totalFiles = Math.max(job.totalFiles || 0, 0)
      const completedFiles = Math.max(job.completedFiles || 0, 0)
      const percent = totalFiles > 0 ? Math.round((completedFiles / totalFiles) * 100) : 0
      const isScanning = job.scanStatus !== 'complete'
      return {
        detail: isScanning
          ? `${totalFiles.toLocaleString()} files found`
          : `${completedFiles.toLocaleString()}/${totalFiles.toLocaleString()} files`,
        label: isScanning ? 'Scanning' : job.status === 'running' ? 'Uploading' : 'Queued',
        percent,
        status: job.status === 'running' ? 'uploading' : 'queued',
      }
    }

    return {
      detail: hasRemoteEntry ? 'Stored in vault' : 'Waiting to upload',
      label: hasRemoteEntry ? 'In Nubem' : 'Queued',
      percent: hasRemoteEntry ? 100 : 0,
      status: hasRemoteEntry ? 'synced' : 'queued',
    }
  }

  const percent = Math.round((files.reduce((sum, file) => sum + uploadRatio(file), 0) / files.length) * 100)
  const errored = files.find((file) => file.status === 'error')
  if (errored) {
    return {
      detail: errored.error || 'Upload failed',
      label: 'Error',
      percent,
      status: 'error',
    }
  }

  if (files.every((file) => file.status === 'done')) {
    return {
      detail: files.length === 1 ? 'Stored in vault' : `${files.length}/${files.length} files`,
      label: 'In Nubem',
      percent: 100,
      status: 'synced',
    }
  }

  const active = files.find((file) => file.status === 'uploading')
  const waiting = files.find((file) => file.uploadedBytes >= file.sizeBytes && file.status !== 'done')
  return {
    detail: active?.error || waiting?.error || (files.length === 1 ? baseName(files[0].relativePath) : `${percent}% uploaded`),
    label: active ? 'Uploading' : waiting ? 'Waiting' : 'Queued',
    percent,
    status: active || waiting ? 'uploading' : 'queued',
  }
}

function localPathSeparator(localPath: string) {
  return localPath.includes('\\') ? '\\' : '/'
}

function dropLocalPathSegments(localPath: string, count: number) {
  if (count <= 0) return localPath
  const separator = localPathSeparator(localPath)
  const parts = localPath.split(/[\\/]/)
  return parts.slice(0, Math.max(1, parts.length - count)).join(separator)
}

function localPathForVaultPath(jobs: SyncJob[], relativePath: string, type: RemoteEntry['type']) {
  const path = normalizeVaultPath(relativePath)

  for (const job of jobs) {
    const rootName = normalizeVaultPath(job.rootName)
    if (path === rootName) return job.rootPath
    if (!path.startsWith(`${rootName}/`)) continue

    const exactFile = job.files.find((file) => normalizeVaultPath(file.relativePath) === path)
    if (type === 'file' && exactFile) return exactFile.sourcePath

    const childFile = job.files.find((file) => normalizeVaultPath(file.relativePath).startsWith(`${path}/`))
    if (!childFile) continue

    const suffix = normalizeVaultPath(childFile.relativePath).slice(path.length).replace(/^\/+/, '')
    return dropLocalPathSegments(childFile.sourcePath, suffix.split('/').filter(Boolean).length)
  }

  return ''
}

function virtualRowsForListing(listing: RemoteListing | null, jobs: SyncJob[], existingPaths: Set<string>) {
  const currentPath = listing?.path || ''
  const groups = new Map<string, Array<SyncJob['files'][number]>>()
  const jobIdsByPath = new Map<string, string>()

  for (const job of jobs) {
    for (const file of job.files) {
      if (file.status === 'done') continue
      const childPath = childPathForListing(currentPath, file.relativePath)
      if (!childPath || existingPaths.has(childPath)) continue
      groups.set(childPath, [...(groups.get(childPath) || []), file])
      if (!jobIdsByPath.has(childPath)) {
        jobIdsByPath.set(childPath, job.id)
      }
    }
  }

  if (!normalizeVaultPath(currentPath)) {
    for (const job of jobs) {
      if (job.status === 'complete') continue
      const rootPath = normalizeVaultPath(job.rootName)
      if (!rootPath || existingPaths.has(rootPath) || groups.has(rootPath)) continue
      groups.set(rootPath, [])
      jobIdsByPath.set(rootPath, job.id)
    }
  }

  return Array.from(groups.entries()).map(([relativePath, files]) => {
    const isFile = files.some((file) => normalizeVaultPath(file.relativePath) === relativePath)
    const modifiedAt = files
      .map((file) => new Date(file.modifiedAt || 0).getTime())
      .filter(Number.isFinite)
      .sort((left, right) => right - left)[0]

    return {
      name: baseName(relativePath),
      type: isFile ? 'file' : 'directory',
      relativePath,
      sizeBytes: isFile ? files.find((file) => normalizeVaultPath(file.relativePath) === relativePath)?.sizeBytes || 0 : 0,
      sizeLabel: isFile ? formatSizeLabel(files.find((file) => normalizeVaultPath(file.relativePath) === relativePath)?.sizeBytes || 0) : '',
      modifiedAt: modifiedAt ? new Date(modifiedAt).toISOString() : '',
      localPath: localPathForVaultPath(jobs, relativePath, isFile ? 'file' : 'directory'),
      progress: progressForVaultPath(jobs, relativePath, isFile ? 'file' : 'directory', false),
      syncJobId: jobIdsByPath.get(relativePath),
      virtual: true,
    } satisfies RemoteBrowserRow
  })
}

function formatSizeLabel(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`
}

function formatVaultGb(folder: CloudFolder) {
  if (!Number.isFinite(folder.sizeBytes)) {
    return folder.sizeLabel || '0 GB'
  }

  const bytes = Math.max(0, folder.sizeBytes || 0)
  if (bytes === 0) return '0 GB'

  const gb = bytes / 1024 ** 3
  if (gb < 0.01) return '<0.01 GB'
  if (gb >= 100) return `${Math.round(gb).toLocaleString()} GB`
  return `${gb >= 10 ? gb.toFixed(1) : gb.toFixed(2)} GB`
}

function serverClientVaults(folder: CloudFolder) {
  return Array.isArray(folder.clientVaults) ? folder.clientVaults : []
}

function vaultCountLabel(folder: CloudFolder) {
  const count = serverClientVaults(folder).length || folder.devices.length
  return count === 1 ? '1 vault' : `${count} vaults`
}

function onlineClientCount(folder: CloudFolder) {
  const vaults = serverClientVaults(folder)
  if (vaults.length > 0) {
    return vaults.filter((vault) => vault.status === 'online').length
  }

  return folder.devices.length
}

function formatRate(bytesPerSecond: number) {
  return `${formatSizeLabel(Math.max(0, bytesPerSecond || 0))}/s`
}

function currentVpsStats(state: AppState): VpsStats {
  const queueStages = state.vpsStats?.queue?.stages
  const queueFiles = Math.max(0, state.vpsStats?.queue?.files || 0)
  const queueBytes = Math.max(0, state.vpsStats?.queue?.bytes || 0)
  const doneFiles = Math.max(0, state.vpsStats?.queue?.doneFiles || 0)
  const doneBytes = Math.max(0, state.vpsStats?.queue?.doneBytes || 0)
  const queueItems = Array.isArray(state.vpsStats?.queue?.items)
    ? state.vpsStats.queue.items
        .slice(0, 12)
        .map((item) => ({
          id: item.id || '',
          type: item.type === 'download' ? 'download' as const : 'upload' as const,
          status: item.status === 'uploading' || item.status === 'ready' ? item.status : 'pending' as const,
          stage: item.stage || 'waiting-server',
          stageLabel: item.stageLabel || '',
          vaultName: item.vaultName || 'Vault',
          clientName: item.clientName || 'Client',
          fileName: item.fileName || 'File',
          relativePath: item.relativePath || '',
          bytes: Math.max(0, item.bytes || 0),
          transferredBytes: Math.max(0, item.transferredBytes || 0),
          totalBytes: Math.max(0, item.totalBytes || 0),
          createdAt: item.createdAt || '',
          updatedAt: item.updatedAt || item.createdAt || '',
        }))
        .filter((item) => item.id)
    : []

  return {
    updatedAt: state.vpsStats?.updatedAt || '',
    traffic: {
      inboundBytesPerSecond: Math.max(0, state.vpsStats?.traffic?.inboundBytesPerSecond || 0),
      outboundBytesPerSecond: Math.max(0, state.vpsStats?.traffic?.outboundBytesPerSecond || 0),
    },
    queue: {
      files: queueFiles,
      bytes: queueBytes,
      doneFiles,
      doneBytes,
      totalFiles: Math.max(0, state.vpsStats?.queue?.totalFiles || queueFiles + doneFiles),
      totalBytes: Math.max(0, state.vpsStats?.queue?.totalBytes || queueBytes + doneBytes),
      oldestAt: state.vpsStats?.queue?.oldestAt || '',
      stages: {
        clientToVps: Math.max(0, queueStages?.clientToVps || 0),
        waitingServer: Math.max(0, queueStages?.waitingServer || 0),
        serverToVps: Math.max(0, queueStages?.serverToVps || 0),
        vpsToServer: Math.max(0, queueStages?.vpsToServer || 0),
        waitingClient: Math.max(0, queueStages?.waitingClient || 0),
        vpsToClient: Math.max(0, queueStages?.vpsToClient || 0),
        done: Math.max(0, queueStages?.done || 0),
      },
      items: queueItems,
    },
    storage: {
      usedBytes: Math.max(0, state.vpsStats?.storage?.usedBytes || 0),
      freeBytes: Math.max(0, state.vpsStats?.storage?.freeBytes || 0),
      totalBytes: Math.max(0, state.vpsStats?.storage?.totalBytes || 0),
      usedPercent: Math.max(0, Math.min(100, state.vpsStats?.storage?.usedPercent || 0)),
    },
  }
}

function currentServerTransfers(state: AppState): TrafficTransfer[] {
  const cutoff = Date.now() - 20_000
  return Array.isArray(state.traffic?.active)
    ? state.traffic.active
        .filter((transfer) => transfer.id && new Date(transfer.updatedAt || 0).getTime() >= cutoff)
        .map((transfer) => ({
          ...transfer,
          direction: transfer.direction === 'download' ? 'download' as const : 'upload' as const,
          vaultName: transfer.vaultName || 'Vault',
          clientName: transfer.clientName || 'Client',
          fileName: transfer.fileName || 'File',
          relativePath: transfer.relativePath || '',
          totalBytes: Math.max(0, transfer.totalBytes || 0),
          transferredBytes: Math.max(0, transfer.transferredBytes || 0),
          rateBytesPerSecond: Math.max(0, transfer.rateBytesPerSecond || 0),
        }))
        .sort((left, right) => right.rateBytesPerSecond - left.rateBytesPerSecond)
    : []
}

function transferPercent(transfer: Pick<TrafficTransfer, 'totalBytes' | 'transferredBytes'>) {
  if (!transfer.totalBytes) return 0
  return Math.max(0, Math.min(100, Math.round((transfer.transferredBytes / transfer.totalBytes) * 100)))
}

function matchesFilter(folder: CloudFolder, filter: FilterKey) {
  if (filter === 'local') return folder.localMode === 'local' || folder.localMode === 'mirror'
  if (filter === 'online') return folder.localMode === 'online'
  if (filter === 'syncing') return folder.status === 'syncing' || folder.status === 'queued'
  return true
}

function App() {
  const [state, setState] = useState<AppState>(demoState)
  const [selectedId, setSelectedId] = useState(demoState.folders[0]?.id)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [isLoading, setIsLoading] = useState(true)
  const [pairBusy, setPairBusy] = useState<PairBusy>(null)
  const [pairError, setPairError] = useState('')
  const [remoteListing, setRemoteListing] = useState<RemoteListing | null>(null)
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [remoteError, setRemoteError] = useState('')
  const [remoteNotice, setRemoteNotice] = useState('')
  const [shareDialog, setShareDialog] = useState<ShareDialogState>(null)

  const api = window.nubemDrive

  useEffect(() => {
    let active = true

    async function loadState() {
      try {
        const nextState = api ? await api.getState() : demoState
        if (!active) return

        setState(nextState)
        setSelectedId((currentId) => {
          if (currentId && nextState.folders.some((folder) => folder.id === currentId)) {
            return currentId
          }

          return nextState.folders[0]?.id
        })
      } finally {
        if (active) {
          setIsLoading(false)
        }
      }
    }

    loadState()
    const interval = window.setInterval(loadState, 2000)

    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [api])

  const folders = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    return state.folders.filter((folder) => {
      const queryMatch =
        normalizedQuery.length === 0 ||
        folder.name.toLowerCase().includes(normalizedQuery) ||
        folder.path.toLowerCase().includes(normalizedQuery)

      return queryMatch && matchesFilter(folder, filter)
    })
  }, [filter, query, state.folders])

  const selectedFolder = state.folders.find((folder) => folder.id === selectedId) || folders[0] || state.folders[0]
  const selectedFolderId = selectedFolder?.id
  const selectedIsClientVault = selectedFolder?.vaultRole === 'client'
  const selectedIsLinkedClientVault = selectedIsClientVault && Boolean(selectedFolder?.pairId && selectedFolder.token)
  const isServerApp = state.appMode === 'server'
  const serverVpsStats = useMemo(() => currentVpsStats(state), [state])
  const serverTransfers = useMemo(() => currentServerTransfers(state), [state])
  const connection = connectionSummary(state, pairBusy, pairError)
  const canChooseFolders = isServerApp || Boolean(selectedIsLinkedClientVault)
  const chooseFoldersTitle = isServerApp
    ? 'Add storage'
    : selectedIsLinkedClientVault
      ? 'Add to Nubem'
      : 'Waiting for Nubem Server'
  const selectedSyncJobs = useMemo(() => {
    if (!selectedFolderId) return []
    return state.syncJobs
      .filter((job) => job.vaultFolderId === selectedFolderId)
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
  }, [selectedFolderId, state.syncJobs])
  const currentRole = roleBadge(state)

  useEffect(() => {
    let active = true

    async function loadRemoteRoot() {
      if (!api || !selectedFolderId || !selectedIsLinkedClientVault) {
        setRemoteListing(null)
        setRemoteError('')
        return
      }

      setRemoteBusy(true)
      setRemoteError('')

      try {
        const listing = await api.browseRemoteFolder(selectedFolderId, '')
        if (active) {
          setRemoteListing(listing)
        }
      } catch (error) {
        if (active) {
          setRemoteError(error instanceof Error ? error.message : 'Could not browse')
        }
      } finally {
        if (active) {
          setRemoteBusy(false)
        }
      }
    }

    loadRemoteRoot()

    return () => {
      active = false
    }
  }, [api, selectedFolderId, selectedIsLinkedClientVault])

  useEffect(() => {
    if (!api || !selectedFolderId || !selectedIsLinkedClientVault) {
      return
    }

    const driveApi = api
    let active = true
    let inFlight = false

    async function refreshCurrentRemotePath() {
      if (inFlight) return
      inFlight = true

      try {
        const listing = await driveApi.browseRemoteFolder(selectedFolderId, remoteListing?.path || '')
        if (active) {
          setRemoteListing(listing)
        }
      } catch {
        // The connection strip already reports server availability; keep the file list stable during retries.
      } finally {
        inFlight = false
      }
    }

    const interval = window.setInterval(refreshCurrentRemotePath, 5000)

    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [api, selectedFolderId, selectedIsLinkedClientVault, remoteListing?.path])

  async function chooseFolders() {
    if (!api) return
    if (!isServerApp && !selectedIsLinkedClientVault) {
      await refreshConnection()
      return
    }

    setRemoteBusy(true)
    setRemoteError('')
    setRemoteNotice(selectedIsLinkedClientVault ? 'Uploading' : '')
    try {
      const nextState = await api.chooseFolders()
      setState(nextState)
      setSelectedId((currentId) => {
        if (selectedIsLinkedClientVault && selectedFolder) return selectedFolder.id
        if (currentId && nextState.folders.some((folder) => folder.id === currentId)) return currentId
        return nextState.folders[0]?.id
      })
      if (selectedFolder && selectedIsLinkedClientVault) {
        setRemoteListing(await api.browseRemoteFolder(selectedFolder.id, remoteListing?.path || ''))
        setRemoteNotice('Queued for Nubem')
      } else {
        setRemoteNotice('')
      }
    } catch (error) {
      setRemoteNotice('')
      setRemoteError(error instanceof Error ? error.message : 'Could not add folder')
    } finally {
      setRemoteBusy(false)
    }
  }

  function revealLocalPath(localPath: string) {
    api?.revealFolder(localPath)
  }

  async function browseRemotePath(relativePath: string) {
    if (!api || !selectedFolder) return
    setRemoteBusy(true)
    setRemoteError('')
    setRemoteNotice('')
    try {
      setRemoteListing(await api.browseRemoteFolder(selectedFolder.id, relativePath))
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : 'Could not browse')
    } finally {
      setRemoteBusy(false)
    }
  }

  async function downloadRemoteEntry(entry: RemoteEntry) {
    if (!api || !selectedFolder || entry.type !== 'file') return
    setRemoteBusy(true)
    setRemoteError('')
    setRemoteNotice('')
    try {
      await api.downloadRemoteFile(selectedFolder.id, entry.relativePath)
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : 'Could not download')
    } finally {
      setRemoteBusy(false)
    }
  }

  async function deleteRemoteEntry(entry: RemoteEntry) {
    if (!api || !selectedFolder) return
    setRemoteBusy(true)
    setRemoteError('')
    setRemoteNotice('')
    try {
      const result = await api.deleteRemoteEntry(selectedFolder.id, entry.relativePath)
      if (result.ok) {
        setState(await api.getState())
        setRemoteListing(await api.browseRemoteFolder(selectedFolder.id, remoteListing?.path || ''))
      }
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : 'Could not delete')
    } finally {
      setRemoteBusy(false)
    }
  }

  async function cancelSyncJob(jobId: string) {
    if (!api || !selectedFolder) return
    setRemoteBusy(true)
    setRemoteError('')
    setRemoteNotice('')
    try {
      const nextState = await api.cancelSyncJob(jobId)
      setState(nextState)
      setRemoteNotice('Upload canceled')
      setRemoteListing(await api.browseRemoteFolder(selectedFolder.id, remoteListing?.path || ''))
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : 'Could not cancel upload')
    } finally {
      setRemoteBusy(false)
    }
  }

  async function shareRemoteEntry(entry: RemoteEntry) {
    if (!api || !selectedFolder) return
    setShareDialog({ busy: true, copied: false, entry, error: '', share: null })
    try {
      const share = await api.createShareLink(selectedFolder.id, entry.relativePath, entry.type, entry.name)
      setShareDialog({ busy: false, copied: false, entry, error: '', share })
    } catch (error) {
      setShareDialog({
        busy: false,
        copied: false,
        entry,
        error: error instanceof Error ? error.message : 'Could not create share link',
        share: null,
      })
    }
  }

  async function copyShareUrl() {
    if (!api || !shareDialog?.share?.url) return
    await api.copyText(shareDialog.share.url)
    setShareDialog((current) => current ? { ...current, copied: true } : current)
  }

  async function refreshConnection() {
    if (!api) return
    setPairBusy('retry')
    setPairError('')
    try {
      const nextState = await api.refreshPairing()
      const joinedVault = clientVaults(nextState)[0]
      setState(nextState)
      if (joinedVault) {
        setSelectedId(joinedVault.id)
      }
    } catch (error) {
      setPairError(error instanceof Error ? error.message : 'Could not set up vault')
    } finally {
      setPairBusy(null)
    }
  }

  async function handleUpdateClick() {
    if (!api) return
    const status = state.updates.status
    if (status === 'downloading' || status === 'installing') return

    if (status === 'ready') {
      setState(await api.installUpdate())
      return
    }

    if (status === 'available') {
      setState(await api.downloadUpdate())
      return
    }

    setState(await api.checkForUpdates())
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Primary">
        <div className="brand-lockup" title={isServerApp ? 'Nubem Server' : 'Nubem Drive'}>
          <div className="brand-mark">
            <Cloud size={22} strokeWidth={2.4} />
          </div>
        </div>

        <div className={`role-pill ${currentRole.className}`} title={currentRole.title} aria-label={currentRole.title}>
          {currentRole.label}
        </div>

        {!isServerApp ? (
          <SidebarConnectionIndicator
            connection={connection}
            onOpen={refreshConnection}
          />
        ) : null}

        <div className="version-chip" title={versionTitle(state)}>
          v{state.updates.currentVersion}
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>{isServerApp ? 'Storage' : 'Vault'}</h1>
          </div>
          <div className="topbar-actions">
            <label className="search-box">
              <Search size={18} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />
            </label>
            {visibleUpdateStatuses.has(state.updates.status) ? (
              <button
                className={`icon-button update-button ${state.updates.status}`}
                disabled={state.updates.status === 'downloading' || state.updates.status === 'installing'}
                onClick={handleUpdateClick}
                title={updateTitle(state)}
                aria-label={updateTitle(state)}
              >
                {state.updates.status === 'downloading' || state.updates.status === 'installing' ? (
                  <RefreshCcw size={18} />
                ) : (
                  <Download size={18} />
                )}
              </button>
            ) : null}
            <button
              className="primary-button storage-button"
              disabled={!canChooseFolders}
              onClick={chooseFolders}
              title={chooseFoldersTitle}
              aria-label={chooseFoldersTitle}
            >
              <Plus size={18} />
              <span>{isServerApp ? 'Add storage' : 'Add to Nubem'}</span>
            </button>
          </div>
        </header>

        {!isServerApp ? (
          <ConnectionStrip
            busy={pairBusy}
            error={pairError}
            onOpen={refreshConnection}
            state={state}
          />
        ) : null}

        <div className="content-grid">
          <section className={`folder-browser ${selectedIsClientVault ? 'remote-panel' : ''}`} aria-label={selectedIsClientVault ? 'Vault files' : isServerApp ? 'Vaults' : 'Cloud folders'}>
            {selectedIsClientVault && !selectedIsLinkedClientVault ? (
              <div className={`empty-state vault-waiting-state ${connection.tone}`}>
                <RefreshCcw size={22} />
                <strong>{connection.title}</strong>
                <span>{connection.detail}</span>
              </div>
            ) : selectedIsClientVault ? (
              <RemoteBrowser
                busy={remoteBusy}
                error={remoteError}
                jobs={selectedSyncJobs}
                listing={remoteListing}
                notice={remoteNotice}
                onDelete={deleteRemoteEntry}
                onDownload={downloadRemoteEntry}
                onOpen={browseRemotePath}
                onReveal={revealLocalPath}
                onCancelSyncJob={cancelSyncJob}
                onShare={shareRemoteEntry}
              />
            ) : (
              <>
                {isServerApp ? (
                  <ServerVpsPanel stats={serverVpsStats} transfers={serverTransfers} />
                ) : null}

                <div className="browser-toolbar">
                  {isServerApp ? (
                    <div className="server-vault-head" aria-hidden="true">
                      <span>Vault</span>
                      <span>Online</span>
                      <span>Used</span>
                      <span>Status</span>
                    </div>
                  ) : (
                    <div className="segmented-control">
                      {filters.map((item) => {
                        const Icon = filterIcons[item.key]
                        return (
                          <button
                            aria-label={item.label}
                            className={filter === item.key ? 'selected' : ''}
                            key={item.key}
                            onClick={() => setFilter(item.key)}
                            title={item.label}
                          >
                            <Icon size={16} />
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>

                <div className="folder-list">
                  {isLoading ? (
                    <div className="empty-state">Loading</div>
                  ) : folders.length === 0 ? (
                    isServerApp ? (
                      <div className="empty-state action-state server-empty-state">
                        <button className="primary-button storage-button" onClick={chooseFolders}>
                          <Plus size={17} />
                          Add storage
                        </button>
                      </div>
                    ) : (
                      <div className="empty-state">No folders</div>
                    )
                  ) : (
                    folders.map((folder) =>
                      isServerApp ? (
                        <ServerVaultRow
                          folder={folder}
                          isSelected={selectedFolder?.id === folder.id}
                          key={folder.id}
                          onSelect={() => setSelectedId(folder.id)}
                        />
                      ) : (
                        <FolderRow
                          folder={folder}
                          isSelected={selectedFolder?.id === folder.id}
                          key={folder.id}
                          onSelect={() => setSelectedId(folder.id)}
                        />
                      )
                    )
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </section>

      {shareDialog ? (
        <ShareDialog
          copied={shareDialog.copied}
          dialog={shareDialog}
          onClose={() => setShareDialog(null)}
          onCopy={copyShareUrl}
        />
      ) : null}

    </main>
  )
}

function RemoteBrowser({
  busy,
  error,
  jobs,
  listing,
  notice,
  onDelete,
  onDownload,
  onOpen,
  onReveal,
  onCancelSyncJob,
  onShare,
}: {
  busy: boolean
  error: string
  jobs: SyncJob[]
  listing: RemoteListing | null
  notice: string
  onDelete: (entry: RemoteEntry) => void
  onDownload: (entry: RemoteEntry) => void
  onOpen: (relativePath: string) => void
  onReveal: (localPath: string) => void
  onCancelSyncJob: (jobId: string) => void
  onShare: (entry: RemoteEntry) => void
}) {
  const [sortKey, setSortKey] = useState<RemoteSortKey>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const crumbs = pathCrumbs(listing?.path || '')
  const remoteEntries = listing?.entries || []
  const existingPaths = new Set(remoteEntries.map((entry) => normalizeVaultPath(entry.relativePath)))
  const rows: RemoteBrowserRow[] = [
    ...remoteEntries.map((entry) => ({
      ...entry,
      localPath: localPathForVaultPath(jobs, entry.relativePath, entry.type),
      progress: progressForVaultPath(jobs, entry.relativePath, entry.type, true),
      syncJobId: syncJobForVaultPath(jobs, entry.relativePath)?.id,
    })),
    ...virtualRowsForListing(listing, jobs, existingPaths),
  ].sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1

    const direction = sortDirection === 'asc' ? 1 : -1
    const nameResult = left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    if (sortKey === 'modified') {
      const leftTime = new Date(left.modifiedAt || 0).getTime()
      const rightTime = new Date(right.modifiedAt || 0).getTime()
      const result = (leftTime - rightTime) * direction
      if (result !== 0) return result
      return nameResult
    }

    if (sortKey === 'size') {
      const result = (left.sizeBytes - right.sizeBytes) * direction
      if (result !== 0) return result
      return nameResult
    }

    return nameResult * direction
  })

  function changeSort(nextKey: RemoteSortKey) {
    if (sortKey === nextKey) {
      setSortDirection((currentDirection) => (currentDirection === 'asc' ? 'desc' : 'asc'))
      return
    }

    setSortKey(nextKey)
    setSortDirection(nextKey === 'name' ? 'asc' : 'desc')
  }

  return (
    <section className="remote-browser" aria-label="Remote files">
      <div className="remote-head">
        <div className="remote-title">
          <strong>{listing?.path ? listing.path.split('/').slice(-1)[0] : 'Files'}</strong>
          <span>{rows.length.toLocaleString()} items</span>
        </div>
        {listing?.path ? (
          <button className="icon-button compact" onClick={() => onOpen(listing.parentPath)} title="Up" aria-label="Up">
            <ArrowUp size={16} />
          </button>
        ) : null}
      </div>

      <nav className="remote-crumbs" aria-label="Path">
        {crumbs.map((crumb, index) => (
          <span key={crumb.path || 'root'}>
            {index > 0 ? <ChevronRight size={14} /> : null}
            <button
              className={index === crumbs.length - 1 ? 'current' : ''}
              disabled={index === crumbs.length - 1 || busy}
              onClick={() => onOpen(crumb.path)}
              title={crumb.label}
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>

      {error ? <div className="remote-message">{error}</div> : null}
      {!error && notice ? <div className="remote-message">{notice}</div> : null}
      {busy ? <div className="remote-message">Loading</div> : null}

      <div className="remote-table">
        <div className="remote-table-head">
          <button className={sortKey === 'name' ? 'active' : ''} onClick={() => changeSort('name')}>
            Name {sortKey === 'name' ? sortIcon(sortDirection) : null}
          </button>
          <span>Cloud</span>
          <button className={sortKey === 'size' ? 'active' : ''} onClick={() => changeSort('size')}>
            Size {sortKey === 'size' ? sortIcon(sortDirection) : null}
          </button>
          <button className={sortKey === 'modified' ? 'active' : ''} onClick={() => changeSort('modified')}>
            Modified {sortKey === 'modified' ? sortIcon(sortDirection) : null}
          </button>
          <span />
        </div>

        {listing && rows.length === 0 && !busy ? <div className="remote-message">Empty</div> : null}
        {rows.map((entry) => {
          const canUseRemote = !entry.virtual
          const canReveal = Boolean(entry.localPath)
          const canCancelUpload = Boolean(entry.syncJobId && entry.progress.status !== 'synced')
          return (
          <div
            className={`remote-entry ${entry.virtual ? 'virtual' : ''}`}
            key={`${entry.virtual ? 'local' : 'remote'}:${entry.relativePath}`}
            title={entry.name}
          >
            <button
              className="remote-name"
              disabled={busy || (entry.virtual && !canReveal)}
              onClick={() => {
                if (entry.virtual && entry.localPath) {
                  onReveal(entry.localPath)
                  return
                }

                if (entry.type === 'directory') {
                  onOpen(entry.relativePath)
                  return
                }

                onDownload(entry)
              }}
              title={entry.name}
            >
              <span className="remote-entry-icon">
                {entry.type === 'directory' ? <FolderOpen size={17} /> : <FileText size={17} />}
              </span>
              <span className="remote-name-copy">
                <strong>{entry.name}</strong>
                <small>{entry.type === 'directory' ? 'Folder' : 'File'}</small>
              </span>
            </button>
            <span className={`remote-progress ${entry.progress.status}`} title={entry.progress.detail}>
              <span className="remote-progress-bar" aria-label={`${entry.name} ${entry.progress.percent}% in Nubem`}>
                <span style={{ width: `${entry.progress.percent}%` }} />
              </span>
              <small>{entry.progress.label}</small>
            </span>
            <span className="remote-size">{entry.type === 'directory' ? '-' : entry.sizeLabel}</span>
            <span className="remote-modified">{formatTime(entry.modifiedAt)}</span>
            <span className="remote-actions">
              <button disabled={busy || !canUseRemote} onClick={() => onShare(entry)} title="Share" aria-label={`Share ${entry.name}`}>
                <Share2 size={16} />
              </button>
              {canReveal ? (
                <button disabled={busy} onClick={() => onReveal(entry.localPath || '')} title="Reveal" aria-label={`Reveal ${entry.name}`}>
                  <ExternalLink size={16} />
                </button>
              ) : null}
              {entry.type === 'file' ? (
                <button disabled={busy || !canUseRemote} onClick={() => onDownload(entry)} title="Download" aria-label={`Download ${entry.name}`}>
                  <Download size={16} />
                </button>
              ) : null}
              {canCancelUpload ? (
                <button
                  className="danger-action"
                  disabled={busy}
                  onClick={() => onCancelSyncJob(entry.syncJobId || '')}
                  title="Cancel upload"
                  aria-label={`Cancel upload of ${entry.name}`}
                >
                  <X size={16} />
                </button>
              ) : (
                <button
                  className="danger-action"
                  disabled={busy || !canUseRemote}
                  onClick={() => onDelete(entry)}
                  title="Delete from vault"
                  aria-label={`Delete ${entry.name} from vault`}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </span>
          </div>
        )})}
      </div>
    </section>
  )
}

type PipelineRow = {
  id: string
  stage: string
  stageLabel: string
  status: string
  clientName: string
  vaultName: string
  fileName: string
  relativePath: string
  transferredBytes: number
  totalBytes: number
  rateBytesPerSecond: number
  active: boolean
}

function transferPipelineRow(transfer: TrafficTransfer): PipelineRow {
  const stage = transfer.direction === 'upload' ? 'vps-to-server' : 'server-to-vps'
  return {
    id: transfer.id,
    stage,
    stageLabel: stage === 'vps-to-server' ? 'Server receiving' : 'Server uploading',
    status: 'moving',
    clientName: transfer.clientName,
    vaultName: transfer.vaultName,
    fileName: transfer.fileName,
    relativePath: transfer.relativePath,
    transferredBytes: transfer.transferredBytes,
    totalBytes: transfer.totalBytes,
    rateBytesPerSecond: transfer.rateBytesPerSecond,
    active: true,
  }
}

function queuePipelineRow(item: VpsQueueItem): PipelineRow {
  return {
    id: item.id,
    stage: item.stage,
    stageLabel: item.stageLabel || stageLabel(item.stage),
    status: item.status,
    clientName: item.clientName,
    vaultName: item.vaultName,
    fileName: item.fileName,
    relativePath: item.relativePath,
    transferredBytes: item.transferredBytes,
    totalBytes: item.totalBytes || item.bytes,
    rateBytesPerSecond: 0,
    active: !item.stage.startsWith('waiting') && item.stage !== 'ready',
  }
}

function stageLabel(stage: string) {
  switch (stage) {
    case 'client-to-vps':
      return 'Client uploading'
    case 'server-to-vps':
      return 'Server uploading'
    case 'vps-to-server':
      return 'Server receiving'
    case 'waiting-client':
      return 'Waiting for client'
    case 'vps-to-client':
      return 'Client receiving'
    case 'ready':
      return 'Done, cleaning soon'
    default:
      return 'Waiting for server'
  }
}

function routePath(relativePath: string, fallback: string) {
  return relativePath || fallback || 'File'
}

function rowPercent(row: PipelineRow) {
  return transferPercent({
    transferredBytes: row.transferredBytes,
    totalBytes: row.totalBytes,
  })
}

function routePillLabel(row: PipelineRow) {
  if (row.rateBytesPerSecond > 0) return formatRate(row.rateBytesPerSecond)
  if (row.stage === 'ready') return 'done'
  if (row.stage.startsWith('waiting')) return 'waiting'
  if (row.status === 'uploading') return 'uploading'
  return 'moving'
}

function ServerVpsPanel({ stats, transfers }: { stats: VpsStats; transfers: TrafficTransfer[] }) {
  const transferRows = transfers.slice(0, 4).map(transferPipelineRow)
  const activeIds = new Set(transferRows.map((transfer) => transfer.id))
  const queueRows = (stats.queue.items || [])
    .filter((item) => !activeIds.has(item.id))
    .slice(0, transferRows.length > 0 ? 4 : 6)
    .map(queuePipelineRow)
  const rows = [...transferRows, ...queueRows].slice(0, 8)
  const movingCount = rows.filter((row) => row.active).length
  const unfinishedFiles = stats.queue.files
  const doneFiles = stats.queue.doneFiles || stats.queue.stages.done
  const waitingFiles = stats.queue.stages.waitingServer + stats.queue.stages.waitingClient
  const filesDetail = doneFiles > 0 ? `${doneFiles.toLocaleString()} done` : `${formatSizeLabel(stats.queue.bytes)} staged`
  const routeSummary = movingCount > 0
    ? `${movingCount} moving`
    : waitingFiles > 0
      ? `${waitingFiles} waiting`
      : doneFiles > 0
        ? `${doneFiles} done`
        : 'Nothing moving'

  return (
    <section className="server-vps-panel" aria-label="VPS">
      <div className="vps-metrics">
        <div className="vps-metric">
          <span className="vps-icon traffic">
            <RefreshCcw size={17} />
          </span>
          <span className="vps-copy">
            <strong>Traffic</strong>
            <small>
              <ArrowDown size={13} />
              {formatRate(stats.traffic.inboundBytesPerSecond)}
              <ArrowUp size={13} />
              {formatRate(stats.traffic.outboundBytesPerSecond)}
            </small>
          </span>
        </div>

        <div className="vps-metric">
          <span className="vps-icon queue">
            <FileText size={17} />
          </span>
          <span className="vps-copy">
            <strong>{unfinishedFiles.toLocaleString()} unfinished</strong>
            <small>{filesDetail}</small>
          </span>
        </div>

        <div className="vps-metric">
          <span className="vps-icon storage">
            <HardDrive size={17} />
          </span>
          <span className="vps-copy">
            <strong>{formatSizeLabel(stats.storage.freeBytes)} VPS free</strong>
            <small>{stats.storage.usedPercent}% VPS used</small>
          </span>
        </div>
      </div>

      <div className="vps-routes" aria-label="Traffic routes">
        <div className="vps-routes-head">
          <strong>Files</strong>
          <span>{routeSummary}</span>
        </div>

        {rows.length > 0 ? (
          <div className="vps-route-list">
            {rows.map((row) => {
              const percent = rowPercent(row)
              const isWaiting = row.stage.startsWith('waiting')
              const DirectionIcon = row.stage === 'client-to-vps' || row.stage === 'vps-to-server' ? ArrowDown : ArrowUp
              const pillLabel = routePillLabel(row)
              return (
                <div className={`vps-route ${row.active ? 'active' : 'queued'}`} key={`${row.stage}-${row.id}`}>
                  <span className={`route-icon ${row.stage}`}>
                    <DirectionIcon size={15} />
                  </span>
                  <span className="route-main">
                    <strong>{row.stageLabel}</strong>
                    <small>{row.clientName} / {row.vaultName} / {routePath(row.relativePath, row.fileName)}</small>
                  </span>
                  <span className="route-size">
                    {row.totalBytes > 0
                      ? `${formatSizeLabel(row.transferredBytes)} / ${formatSizeLabel(row.totalBytes)}`
                      : formatSizeLabel(row.transferredBytes || row.totalBytes)}
                  </span>
                  <span className={`route-progress ${isWaiting || !row.totalBytes ? 'waiting' : ''}`} title={row.totalBytes ? `${percent}%` : row.stageLabel}>
                    <span style={{ width: row.totalBytes ? `${percent}%` : '100%' }} />
                  </span>
                  <span className={row.rateBytesPerSecond > 0 ? 'route-rate' : `queue-pill ${row.stage === 'ready' ? 'ready' : row.status}`}>{pillLabel}</span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="vps-route-empty">No live file traffic</div>
        )}
      </div>
    </section>
  )
}

function ShareDialog({
  copied,
  dialog,
  onClose,
  onCopy,
}: {
  copied: boolean
  dialog: NonNullable<ShareDialogState>
  onClose: () => void
  onCopy: () => void
}) {
  const shareUrl = dialog.share?.url || ''
  const expiresLabel = dialog.share
    ? `Expires after ${dialog.share.maxDownloads} downloads or ${formatTime(dialog.share.expiresAt)}`
    : 'Creating link'

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label="Share link"
        aria-modal="true"
        className="share-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong>{dialog.entry.name}</strong>
            <span>{expiresLabel}</span>
          </div>
          <button onClick={onClose} title="Close" aria-label="Close">
            <X size={16} />
          </button>
        </header>

        {dialog.error ? <div className="share-error">{dialog.error}</div> : null}
        {dialog.busy ? <div className="share-loading">Creating link</div> : null}
        {shareUrl ? (
          <div className="share-url-row">
            <input readOnly value={shareUrl} aria-label="Share URL" />
            <button className="primary-button" onClick={onCopy}>
              <Copy size={16} />
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  )
}

function sortIcon(direction: SortDirection) {
  return direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
}

function pathCrumbs(relativePath: string) {
  const parts = relativePath.split('/').filter(Boolean)
  return [
    { label: 'Vault', path: '' },
    ...parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join('/'),
    })),
  ]
}

function ConnectionStrip({
  busy,
  error,
  onOpen,
  state,
}: {
  busy: PairBusy
  error: string
  onOpen: () => void
  state: AppState
}) {
  const connection = connectionSummary(state, busy, error)
  const Icon = connection.icon

  return (
    <section className={`connection-strip ${connection.tone}`} aria-label="Vault connection">
      <span className="connection-icon">
        <Icon size={18} />
      </span>
      <span className="connection-copy">
        <strong>{connection.title}</strong>
        <span>{connection.detail}</span>
      </span>
      {connection.actionLabel ? (
        <button className="connection-action icon-only" onClick={onOpen} title={connection.actionLabel} aria-label={connection.actionLabel} type="button">
          <RefreshCcw size={16} />
        </button>
      ) : null}
    </section>
  )
}

function SidebarConnectionIndicator({
  connection,
  onOpen,
}: {
  connection: ConnectionSummary
  onOpen: () => void
}) {
  const Icon = connection.icon

  return (
    <button
      className={`sidebar-connection ${connection.tone}`}
      onClick={onOpen}
      title={`${connection.title}: ${connection.detail}`}
      aria-label={`${connection.title}: ${connection.detail}`}
      type="button"
    >
      <Icon size={18} />
      <span className="sidebar-connection-dot" />
    </button>
  )
}

function FolderRow({
  folder,
  isSelected,
  onSelect,
}: {
  folder: CloudFolder
  isSelected: boolean
  onSelect: () => void
}) {
  const StatusIcon = statusIcons[folder.status]

  return (
    <button className={isSelected ? 'folder-row selected' : 'folder-row'} onClick={onSelect}>
      <span className="folder-name">
        <span className="small-folder-icon">
          <Folder size={18} />
        </span>
        <strong>{folder.name}</strong>
      </span>
      <span className="mode-pill" title={folder.vaultRole === 'client' ? 'Vault' : 'Storage'} aria-label={folder.vaultRole === 'client' ? 'Vault' : 'Storage'}>
        {folder.vaultRole === 'client' ? <Download size={15} /> : <HardDrive size={15} />}
      </span>
      <span className={`status-pill ${folder.status}`} title={statusCopy[folder.status]} aria-label={statusCopy[folder.status]}>
        <StatusIcon size={15} />
      </span>
      <span className="size-cell">
        <span>{folder.sizeLabel}</span>
      </span>
    </button>
  )
}

function ServerVaultRow({
  folder,
  isSelected,
  onSelect,
}: {
  folder: CloudFolder
  isSelected: boolean
  onSelect: () => void
}) {
  const StatusIcon = statusIcons[folder.status]
  const vaults = serverClientVaults(folder)
  const onlineCount = onlineClientCount(folder)
  const clientTitle = vaults.length > 0
    ? vaults.map((vault) => `${vault.clientName}: ${vault.name} (${vault.status})`).join(', ')
    : folder.devices.length > 0
      ? folder.devices.join(', ')
      : 'No clients connected'

  return (
    <button className={isSelected ? 'server-vault-row selected' : 'server-vault-row'} onClick={onSelect}>
      <span className="server-vault-name">
        <span className="small-folder-icon">
          <HardDrive size={18} />
        </span>
        <span className="server-vault-name-copy">
          <strong>{folder.name}</strong>
          <small>{vaultCountLabel(folder)}</small>
        </span>
      </span>
      <span className="server-vault-clients" title={clientTitle}>
        <Laptop size={15} />
        <span>{onlineCount}</span>
      </span>
      <span className="server-vault-used">{formatVaultGb(folder)}</span>
      <span className={`status-pill ${folder.status}`} title={statusCopy[folder.status]} aria-label={statusCopy[folder.status]}>
        <StatusIcon size={15} />
      </span>
    </button>
  )
}

export default App
