import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  ArrowUp,
  CheckCircle2,
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
  Server,
  Trash2,
  UploadCloud,
  Wifi,
  X,
} from 'lucide-react'
import './App.css'
import type { AppState, CloudFolder, FolderStatus, RemoteEntry, RemoteListing } from './types'

type FilterKey = 'all' | 'local' | 'online' | 'syncing'
type PairBusy = 'code' | 'join' | 'reset' | null

const defaultRelayHost = 'drive.nubem.org'

const demoState: AppState = {
  storageNode: {
    name: 'Main storage',
    path: '/mnt/nubem-storage',
    capacityBytes: 2_000_000_000_000,
    usedBytes: 612_000_000_000,
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
    role: null,
    status: 'idle',
  },
  updates: {
    currentVersion: '0.0.0',
    platform: 'demo',
    status: 'idle',
  },
  folders: [
    {
      id: 'documents',
      name: 'Documents',
      path: '/home/nando/Documents',
      sizeLabel: '38.4 GB',
      itemCount: 18240,
      updatedAt: new Date().toISOString(),
      status: 'synced',
      localMode: 'local',
      devices: ['This PC', 'Laptop'],
      progress: 100,
    },
    {
      id: 'photos',
      name: 'Photos archive',
      path: '/home/nando/Pictures',
      sizeLabel: '426 GB',
      itemCount: 74512,
      updatedAt: new Date().toISOString(),
      status: 'syncing',
      localMode: 'online',
      devices: ['This PC'],
      progress: 64,
    },
    {
      id: 'exports',
      name: 'Work exports',
      path: '/home/nando/Exports',
      sizeLabel: '91.7 GB',
      itemCount: 6310,
      updatedAt: new Date().toISOString(),
      status: 'paused',
      localMode: 'mirror',
      devices: ['This PC', 'Studio'],
      progress: 100,
    },
  ],
  devices: [
    { id: 'main', name: 'This PC', role: 'Storage node', status: 'online', address: 'LAN' },
    { id: 'laptop', name: 'Laptop', role: 'Client', status: 'online', address: 'Relay' },
    { id: 'studio', name: 'Studio', role: 'Client', status: 'sleeping', address: 'Last seen 2h ago' },
  ],
  activity: [
    { id: 'a1', type: 'upload', label: 'Photos archive', detail: '12.8 GB remaining', at: new Date().toISOString() },
    { id: 'a2', type: 'pin', label: 'Documents', detail: 'Kept on Laptop', at: new Date().toISOString() },
    { id: 'a3', type: 'relay', label: 'VPS relay', detail: '164.132.40.140 ready', at: new Date().toISOString() },
  ],
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
  const [relayHost, setRelayHost] = useState(defaultRelayHost)
  const [pairCode, setPairCode] = useState('')
  const [pairBusy, setPairBusy] = useState<PairBusy>(null)
  const [pairError, setPairError] = useState('')
  const [remoteListing, setRemoteListing] = useState<RemoteListing | null>(null)
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [remoteError, setRemoteError] = useState('')

  const api = window.nubemDrive

  useEffect(() => {
    let active = true

    async function loadState() {
      try {
        const nextState = api ? await api.getState() : demoState
        if (!active) return

        setState(nextState)
        setRelayHost((currentHost) => currentHost || nextState.pairing.relayUrl || defaultRelayHost)
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

  const storagePercent = Math.round((state.storageNode.usedBytes / state.storageNode.capacityBytes) * 100)

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
    const nextState = await api.chooseFolders()
    setState(nextState)
    setSelectedId(nextState.folders[0]?.id)
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
    try {
      await api.downloadRemoteFile(selectedFolder.id, entry.relativePath)
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : 'Could not download')
    } finally {
      setRemoteBusy(false)
    }
  }

  async function createPairCode() {
    if (!api) return
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
      const nextState = await api.shareVault(selectedFolder.id, relayHost)
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
      const nextState = await api.joinPairing(relayHost, pairCode)
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

        <section className="storage-panel" aria-label="Storage">
          <div className="storage-heading" title={state.storageNode.name}>
            <Server size={18} />
            <strong>{storagePercent}%</strong>
          </div>
          <div className="meter">
            <span style={{ width: `${storagePercent}%` }} />
          </div>
          <div className="relay-pill" title="Relay ready" aria-label="Relay ready">
            <Wifi size={15} />
          </div>
        </section>

        <section className="device-summary" aria-label="Devices">
          {state.devices.map((device) => (
            <div className="device-row compact" key={device.id} title={`${device.name} - ${device.address}`}>
              <Laptop size={16} />
              <span className={`device-dot ${device.status}`} />
            </div>
          ))}
        </section>
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
            <button
              className="primary-button icon-only"
              onClick={chooseFolders}
              title={selectedIsClientVault ? 'Cloud folder' : 'Add vault'}
              aria-label={selectedIsClientVault ? 'Cloud folder' : 'Add vault'}
            >
              {selectedIsClientVault ? <UploadCloud size={18} /> : <Plus size={18} />}
            </button>
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
            pairCode={pairCode}
            relayHost={relayHost}
            setPairCode={setPairCode}
            setRelayHost={setRelayHost}
            selectedFolder={selectedFolder}
            state={state}
          />
        ) : null}

        <div className="content-grid">
          <section className="folder-browser" aria-label="Cloud folders">
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
                      title="Remove from cloud"
                      aria-label="Remove from cloud"
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

                {selectedFolder.code && !selectedIsClientVault ? <button className="vault-code" onClick={() => navigator.clipboard?.writeText(selectedFolder.code || '')}>{selectedFolder.code}</button> : null}

                {selectedIsClientVault ? (
                  <>
                    <button className="primary-button full-width" onClick={chooseFolders}>
                      <UploadCloud size={17} />
                      Cloud folder
                    </button>
                  <RemoteBrowser
                    busy={remoteBusy}
                    error={remoteError}
                    listing={remoteListing}
                    onDownload={downloadRemoteEntry}
                    onOpen={browseRemotePath}
                  />
                  </>
                ) : (
                  <section className="control-section" aria-label="Vault">
                    <button className="primary-button full-width" onClick={createPairCode}>
                      <KeyRound size={17} />
                      {selectedFolder.code ? 'Copy code' : 'Create code'}
                    </button>
                  </section>
                )}

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
  onDownload,
  onOpen,
}: {
  busy: boolean
  error: string
  listing: RemoteListing | null
  onDownload: (entry: RemoteEntry) => void
  onOpen: (relativePath: string) => void
}) {
  return (
    <section className="remote-browser" aria-label="Remote files">
      <div className="remote-head">
        <strong>{listing?.path ? listing.path.split('/').slice(-1)[0] : 'Files'}</strong>
        {listing?.path ? (
          <button className="icon-button compact" onClick={() => onOpen(listing.parentPath)} title="Up" aria-label="Up">
            <ArrowUp size={16} />
          </button>
        ) : null}
      </div>

      {error ? <div className="remote-message">{error}</div> : null}
      {busy ? <div className="remote-message">Loading</div> : null}

      <div className="remote-list">
        {listing && listing.entries.length === 0 && !busy ? <div className="remote-message">Empty</div> : null}
        {listing?.entries.map((entry) => (
          <button
            className="remote-entry"
            key={entry.relativePath}
            onClick={() => (entry.type === 'directory' ? onOpen(entry.relativePath) : onDownload(entry))}
            title={entry.name}
          >
            <span className="remote-entry-icon">
              {entry.type === 'directory' ? <FolderOpen size={16} /> : <FileText size={16} />}
            </span>
            <span>
              <strong>{entry.name}</strong>
              <small>{entry.type === 'directory' ? 'Folder' : entry.sizeLabel}</small>
            </span>
            {entry.type === 'file' ? <Download size={15} /> : null}
          </button>
        ))}
      </div>
    </section>
  )
}

function PairPanel({
  busy,
  error,
  onClose,
  onCreateCode,
  onJoin,
  onReset,
  pairCode,
  relayHost,
  setPairCode,
  setRelayHost,
  selectedFolder,
  state,
}: {
  busy: PairBusy
  error: string
  onClose: () => void
  onCreateCode: () => void
  onJoin: (event: FormEvent) => void
  onReset: () => void
  pairCode: string
  relayHost: string
  setPairCode: (value: string) => void
  setRelayHost: (value: string) => void
  selectedFolder?: CloudFolder
  state: AppState
}) {
  const pairingMessage = error || state.pairing.message
  const linkedDevices = state.devices.filter((device) => device.id !== state.currentDevice.id)

  return (
    <section className="pair-panel" aria-label="Link devices">
      <div className="pair-panel-head">
        <div>
          <strong>Link</strong>
          <span>{pairingLine(state)}</span>
        </div>
        <button className="icon-button compact" onClick={onClose} title="Close" aria-label="Close">
          <X size={17} />
        </button>
      </div>

      <div className="pair-grid">
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

        <form className="pair-card pair-form" onSubmit={onJoin}>
          <Laptop size={19} />
          <strong>Join</strong>
          <label>
            <span>Host</span>
            <input value={relayHost} onChange={(event) => setRelayHost(event.target.value)} placeholder={defaultRelayHost} />
          </label>
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
              <span className="quiet-chip" key={device.id} title={device.address}>
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
