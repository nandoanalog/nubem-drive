import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  KeyRound,
  Laptop,
  Link2,
  Pause,
  Plus,
  RefreshCcw,
  Search,
  Trash2,
  UploadCloud,
  Wifi,
  X,
} from 'lucide-react'
import './App.css'
import type { AppState, CloudFolder, FolderStatus, RemoteEntry, RemoteListing, SyncJob } from './types'

type FilterKey = 'all' | 'local' | 'online' | 'syncing'
type PairBusy = 'code' | 'join' | 'reset' | 'server' | null
type RemoteSortKey = 'name' | 'modified' | 'size'
type SortDirection = 'asc' | 'desc'

const defaultRelayHost = 'drive.nubem.org'

const demoState: AppState = {
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

function formatPairCode(value?: string) {
  const clean = (value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
  return clean.match(/.{1,4}/g)?.join('-') || clean
}

function pairingLine(state: AppState) {
  const joined = state.folders.filter((folder) => folder.vaultRole === 'client').length
  const shared = state.folders.filter((folder) => folder.vaultRole !== 'client').length
  if (joined > 0) return `${joined} joined`
  if (shared > 0) return `${shared} shared`
  if (state.pairing.status === 'error') return 'Check host'
  return 'No vaults'
}

function roleBadge(state: AppState) {
  const hasClientVault = state.folders.some((folder) => folder.vaultRole === 'client')
  const isServer = state.storageNode.status === 'online' || state.pairing.role === 'storage'
  const isClient = hasClientVault || state.pairing.role !== 'storage'

  if (isServer && isClient) {
    return { label: 'Both', title: 'Server and client', className: 'both' }
  }

  if (isServer) {
    return { label: 'Server', title: 'Server PC', className: 'server' }
  }

  if (isClient) {
    return { label: 'Client', title: 'Client PC', className: 'client' }
  }

  return { label: 'Client', title: 'Client PC', className: 'client' }
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

function deviceRoleLabel(role?: string) {
  if (role === 'Storage node' || role === 'storage') return 'Server'
  if (role === 'This PC') return 'This PC'
  return role || 'Client'
}

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
  const [isPairPanelOpen, setIsPairPanelOpen] = useState(false)
  const [pairCode, setPairCode] = useState('')
  const [pairBusy, setPairBusy] = useState<PairBusy>(null)
  const [pairError, setPairError] = useState('')
  const [remoteListing, setRemoteListing] = useState<RemoteListing | null>(null)
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [remoteError, setRemoteError] = useState('')
  const [remoteNotice, setRemoteNotice] = useState('')

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
      if (!api || !selectedFolderId || !selectedIsClientVault) {
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
  }, [api, selectedFolderId, selectedIsClientVault])

  async function chooseFolders() {
    if (!api) return
    setRemoteBusy(true)
    setRemoteError('')
    setRemoteNotice(selectedIsClientVault ? 'Uploading' : '')
    try {
      const nextState = await api.chooseFolders()
      setState(nextState)
      setSelectedId(nextState.folders[0]?.id)
      if (selectedFolder && selectedIsClientVault) {
        setRemoteListing(await api.browseRemoteFolder(selectedFolder.id, remoteListing?.path || ''))
        setRemoteNotice('Upload complete')
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

  async function removeFolder(folder: CloudFolder) {
    if (!api) return
    const nextState = await api.removeFolder(folder.id)
    setState(nextState)
    setSelectedId((currentId) => {
      if (currentId && nextState.folders.some((item) => item.id === currentId)) {
        return currentId
      }

      return nextState.folders[0]?.id
    })
  }

  function revealFolder(folder: CloudFolder) {
    api?.revealFolder(folder.path)
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

  async function createPairCode() {
    if (!api) return
    if (state.storageNode.status !== 'online' && state.pairing.role !== 'storage') {
      setPairError('Set this PC as server')
      return
    }
    if (!selectedFolder || selectedFolder.vaultRole === 'client') {
      setPairError('Select a vault')
      return
    }
    if (selectedFolder.code) {
      navigator.clipboard?.writeText(selectedFolder.code)
      return
    }

    setPairBusy('code')
    setPairError('')
    try {
      const nextState = await api.shareVault(selectedFolder.id, defaultRelayHost)
      setState(nextState)
    } catch (error) {
      setPairError(error instanceof Error ? error.message : 'Could not create code')
    } finally {
      setPairBusy(null)
    }
  }

  async function joinPairing(event: FormEvent) {
    event.preventDefault()
    if (!api) return
    setPairBusy('join')
    setPairError('')
    try {
      const nextState = await api.joinPairing(defaultRelayHost, pairCode)
      setState(nextState)
      setPairCode('')
    } catch (error) {
      setPairError(error instanceof Error ? error.message : 'Could not join')
    } finally {
      setPairBusy(null)
    }
  }

  async function resetPairing() {
    if (!api) return
    setPairBusy('reset')
    setPairError('')
    try {
      setState(await api.resetPairing())
    } catch (error) {
      setPairError(error instanceof Error ? error.message : 'Could not reset')
    } finally {
      setPairBusy(null)
    }
  }

  async function setServerMode(enabled: boolean) {
    if (!api) return
    setPairBusy('server')
    setPairError('')
    try {
      setState(await api.setServerMode(enabled))
    } catch (error) {
      setPairError(error instanceof Error ? error.message : 'Could not change role')
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
        <div className="brand-lockup" title="Nubem Drive">
          <div className="brand-mark">
            <Cloud size={22} strokeWidth={2.4} />
          </div>
        </div>

        <div className={`role-pill ${currentRole.className}`} title={currentRole.title} aria-label={currentRole.title}>
          {currentRole.label}
        </div>

        <div className="relay-pill" title="Relay ready" aria-label="Relay ready">
          <Wifi size={15} />
        </div>

        <section className="device-summary" aria-label="Devices">
          {state.devices.map((device) => (
            <div
              className="device-row compact"
              key={device.id}
              title={`${device.name} - ${deviceRoleLabel(device.role)}`}
              aria-label={`${device.name} - ${deviceRoleLabel(device.role)}`}
            >
              <Laptop size={16} />
              <span className={`device-dot ${device.status}`} />
            </div>
          ))}
        </section>

        <div className="version-chip" title={versionTitle(state)}>
          v{state.updates.currentVersion}
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>Vaults</h1>
          </div>
          <div className="topbar-actions">
            <label className="search-box">
              <Search size={18} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />
            </label>
            <button
              className={`icon-button link-button ${state.pairing.status}`}
              onClick={() => setIsPairPanelOpen((isOpen) => !isOpen)}
              title="Link devices"
              aria-label="Link devices"
            >
              <Link2 size={18} />
            </button>
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
            {!selectedIsClientVault ? (
              <button
                className="primary-button icon-only"
                onClick={chooseFolders}
                title="Add vault"
                aria-label="Add vault"
              >
                <Plus size={18} />
              </button>
            ) : null}
          </div>
        </header>

        {isPairPanelOpen ? (
          <PairPanel
            busy={pairBusy}
            error={pairError}
            onClose={() => setIsPairPanelOpen(false)}
            onCreateCode={createPairCode}
            onJoin={joinPairing}
            onReset={resetPairing}
            onSetServerMode={setServerMode}
            pairCode={pairCode}
            setPairCode={setPairCode}
            selectedFolder={selectedFolder}
            state={state}
          />
        ) : null}

        <div className="content-grid">
          <section className={`folder-browser ${selectedIsClientVault ? 'remote-panel' : ''}`} aria-label={selectedIsClientVault ? 'Vault files' : 'Cloud folders'}>
            {selectedIsClientVault ? (
              <RemoteBrowser
                busy={remoteBusy}
                error={remoteError}
                listing={remoteListing}
                notice={remoteNotice}
                onDelete={deleteRemoteEntry}
                onDownload={downloadRemoteEntry}
                onOpen={browseRemotePath}
              />
            ) : (
              <>
                <div className="browser-toolbar">
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
                </div>

                <div className="folder-list">
                  {isLoading ? (
                    <div className="empty-state">Loading</div>
                  ) : folders.length === 0 ? (
                    <div className="empty-state">No folders</div>
                  ) : (
                    folders.map((folder) => (
                      <FolderRow
                        folder={folder}
                        isSelected={selectedFolder?.id === folder.id}
                        key={folder.id}
                        onSelect={() => setSelectedId(folder.id)}
                      />
                    ))
                  )}
                </div>
              </>
            )}
          </section>

          <aside className="inspector" aria-label="Folder details">
            {selectedFolder ? (
              <>
                <div className="inspector-head">
                  <div className="folder-glyph">
                    <Folder size={24} />
                  </div>
                  <div>
                    <h2>{selectedFolder.name}</h2>
                  </div>
                </div>

                {!selectedIsClientVault ? (
                  <div className="quick-actions">
                    <button onClick={() => revealFolder(selectedFolder)} title={selectedFolder.path} aria-label="Reveal folder">
                      <ExternalLink size={15} />
                    </button>
                    {selectedFolder.code ? (
                      <button
                        className="code-action"
                        onClick={() => navigator.clipboard?.writeText(selectedFolder.code || '')}
                        title="Copy vault code"
                        aria-label="Copy vault code"
                      >
                        <KeyRound size={15} />
                      </button>
                    ) : null}
                    <button
                      className="danger-action"
                      onClick={() => removeFolder(selectedFolder)}
                      title="Remove from Nubem"
                      aria-label="Remove from Nubem"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ) : null}

                <div className="meta-strip">
                  <span title="Size">{selectedFolder.sizeLabel}</span>
                  <span title="Items">{selectedFolder.itemCount.toLocaleString()}</span>
                  <span title="Updated">{formatTime(selectedFolder.updatedAt)}</span>
                  <span title="Devices">{selectedFolder.devices.length}</span>
                </div>

                {selectedIsClientVault ? <SyncProgressPanel jobs={selectedSyncJobs} /> : null}

                {selectedFolder.code && !selectedIsClientVault ? <button className="vault-code" onClick={() => navigator.clipboard?.writeText(selectedFolder.code || '')}>{selectedFolder.code}</button> : null}

                {!selectedIsClientVault ? (
                  <section className="control-section" aria-label="Vault">
                    <button className="primary-button full-width" onClick={createPairCode}>
                      <KeyRound size={17} />
                      {selectedFolder.code ? 'Copy code' : 'Create code'}
                    </button>
                  </section>
                ) : null}

              </>
            ) : (
              <div className="empty-state">Select a folder</div>
            )}
          </aside>
        </div>
      </section>

    </main>
  )
}

function RemoteBrowser({
  busy,
  error,
  listing,
  notice,
  onDelete,
  onDownload,
  onOpen,
}: {
  busy: boolean
  error: string
  listing: RemoteListing | null
  notice: string
  onDelete: (entry: RemoteEntry) => void
  onDownload: (entry: RemoteEntry) => void
  onOpen: (relativePath: string) => void
}) {
  const [sortKey, setSortKey] = useState<RemoteSortKey>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const crumbs = pathCrumbs(listing?.path || '')
  const entries = [...(listing?.entries || [])].sort((left, right) => {
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
          <span>{entries.length.toLocaleString()} items</span>
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
          <span>Kind</span>
          <button className={sortKey === 'size' ? 'active' : ''} onClick={() => changeSort('size')}>
            Size {sortKey === 'size' ? sortIcon(sortDirection) : null}
          </button>
          <button className={sortKey === 'modified' ? 'active' : ''} onClick={() => changeSort('modified')}>
            Modified {sortKey === 'modified' ? sortIcon(sortDirection) : null}
          </button>
          <span />
        </div>

        {listing && entries.length === 0 && !busy ? <div className="remote-message">Empty</div> : null}
        {entries.map((entry) => (
          <div
            className="remote-entry"
            key={entry.relativePath}
            title={entry.name}
          >
            <button
              className="remote-name"
              disabled={busy}
              onClick={() => (entry.type === 'directory' ? onOpen(entry.relativePath) : onDownload(entry))}
              title={entry.name}
            >
              <span className="remote-entry-icon">
                {entry.type === 'directory' ? <FolderOpen size={17} /> : <FileText size={17} />}
              </span>
              <strong>{entry.name}</strong>
            </button>
            <span className="remote-kind">{entry.type === 'directory' ? 'Folder' : 'File'}</span>
            <span className="remote-size">{entry.type === 'directory' ? '-' : entry.sizeLabel}</span>
            <span className="remote-modified">{formatTime(entry.modifiedAt)}</span>
            <span className="remote-actions">
              {entry.type === 'file' ? (
                <button disabled={busy} onClick={() => onDownload(entry)} title="Download" aria-label={`Download ${entry.name}`}>
                  <Download size={16} />
                </button>
              ) : null}
              <button
                className="danger-action"
                disabled={busy}
                onClick={() => onDelete(entry)}
                title="Delete from vault"
                aria-label={`Delete ${entry.name} from vault`}
              >
                <Trash2 size={16} />
              </button>
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function SyncProgressPanel({ jobs }: { jobs: SyncJob[] }) {
  if (jobs.length === 0) return null

  return (
    <section className="sync-progress-panel" aria-label="Sync progress">
      <div className="sync-progress-head">
        <UploadCloud size={16} />
        <strong>Sync</strong>
      </div>
      {jobs.slice(0, 4).map((job) => {
        const total = Math.max(job.totalFiles, job.files.length, 0)
        const completed = job.completedFiles
        const currentFile = job.files.find((file) => file.status !== 'done')
        const activeFileProgress = currentFile && currentFile.sizeBytes > 0
          ? Math.min(Math.max(currentFile.uploadedBytes / currentFile.sizeBytes, 0), 1)
          : 0
        const percent = total === 0 ? 100 : Math.round(((completed + activeFileProgress) / total) * 100)
        const status = job.lastError || currentFile?.error || (job.status === 'complete' ? 'Complete' : currentFile?.relativePath || statusCopy.syncing)
        const statusLabel = job.status === 'running' ? 'Syncing' : job.status === 'queued' ? 'Queued' : job.status === 'complete' ? 'Synced' : 'Error'

        return (
          <div className={`sync-job ${job.status}`} key={job.id}>
            <div className="sync-job-title">
              <strong title={job.rootPath}>{job.rootName}</strong>
              <span>{completed}/{total}</span>
            </div>
            <div className="sync-job-bar" aria-label={`${job.rootName} ${percent}%`}>
              <span style={{ width: `${percent}%` }} />
            </div>
            <div className="sync-job-detail" title={status}>
              <span>{statusLabel}</span>
              <span>{status}</span>
            </div>
          </div>
        )
      })}
    </section>
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

function PairPanel({
  busy,
  error,
  onClose,
  onCreateCode,
  onJoin,
  onReset,
  onSetServerMode,
  pairCode,
  setPairCode,
  selectedFolder,
  state,
}: {
  busy: PairBusy
  error: string
  onClose: () => void
  onCreateCode: () => void
  onJoin: (event: FormEvent) => void
  onReset: () => void
  onSetServerMode: (enabled: boolean) => void
  pairCode: string
  setPairCode: (value: string) => void
  selectedFolder?: CloudFolder
  state: AppState
}) {
  const pairingMessage = error || state.pairing.message
  const linkedDevices = state.devices.filter((device) => device.id !== state.currentDevice.id)
  const isServer = state.storageNode.status === 'online' || state.pairing.role === 'storage'
  const canSetServer = state.currentDevice.platform === 'linux'
  const serverButtonLabel = isServer ? 'Use as client' : 'Set this PC as server'

  return (
    <section className="pair-panel" aria-label="Link devices">
      <div className="pair-panel-head">
        <div>
          <strong>Link</strong>
          <span>{pairingLine(state)}</span>
        </div>
        <div className="pair-panel-actions">
          <button
            className={`server-toggle ${isServer ? 'is-server' : ''}`}
            disabled={busy === 'server' || !canSetServer}
            onClick={() => onSetServerMode(!isServer)}
            title={canSetServer ? serverButtonLabel : 'Server mode is available on Linux'}
            type="button"
          >
            <HardDrive size={16} />
            <span>{busy === 'server' ? '...' : serverButtonLabel}</span>
          </button>
          <button className="icon-button compact" onClick={onClose} title="Close" aria-label="Close">
            <X size={17} />
          </button>
        </div>
      </div>

      <div className="pair-grid single">
        {isServer ? (
          <div className="pair-card">
            <HardDrive size={19} />
            <strong>Vault</strong>
            <button className="primary-button" disabled={busy === 'code'} onClick={onCreateCode}>
              {busy === 'code' ? '...' : selectedFolder?.code ? 'Copy code' : 'Show code'}
            </button>
            {selectedFolder?.code ? (
              <button
                className="pair-code"
                onClick={() => navigator.clipboard?.writeText(selectedFolder.code || '')}
                title="Copy code"
              >
                {formatPairCode(selectedFolder.code)}
              </button>
            ) : null}
          </div>
        ) : (
          <form className="pair-card pair-form" onSubmit={onJoin}>
            <Laptop size={19} />
            <strong>Join</strong>
            <label>
              <span>Code</span>
              <input
                autoCapitalize="characters"
                inputMode="text"
                maxLength={14}
                spellCheck={false}
                value={pairCode}
                onChange={(event) => setPairCode(formatPairCode(event.target.value))}
                placeholder="ABCD-2345-WXYZ"
              />
            </label>
            <button className="primary-button" disabled={busy === 'join'} type="submit">
              {busy === 'join' ? '...' : 'Join'}
            </button>
          </form>
        )}
      </div>

      <div className="pair-footer">
        <div className="linked-devices">
          {linkedDevices.length === 0 ? (
            <span className="quiet-chip">
              <KeyRound size={14} />
              {state.pairing.status === 'waiting' ? 'Code ready' : 'No devices'}
            </span>
          ) : (
            linkedDevices.map((device) => (
              <span className="quiet-chip" key={device.id} title={deviceRoleLabel(device.role)}>
                <Laptop size={14} />
                {device.name}
              </span>
            ))
          )}
        </div>
        <button className="text-button" disabled={busy === 'reset'} onClick={onReset}>
          Reset
        </button>
      </div>

      {pairingMessage ? <div className="pair-message">{pairingMessage}</div> : null}
    </section>
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
      <span className="mode-pill" title={folder.vaultRole === 'client' ? 'Joined' : 'Shared'} aria-label={folder.vaultRole === 'client' ? 'Joined' : 'Shared'}>
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

export default App
