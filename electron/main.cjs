const { app, BrowserWindow, Notification, dialog, ipcMain, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const isDev = !app.isPackaged;
let mainWindow;
let heartbeatTimer;
let updateTimer;
let updateWork;
let syncTimer;
let syncWork;
let storageServiceStatusCache = { checkedAt: 0, value: 'offline' };

const dataFile = () => path.join(app.getPath('userData'), 'state.json');
const defaultRelayUrl = 'https://drive.nubem.org';
const defaultUpdateManifestUrl = `${defaultRelayUrl}/latest.json`;
const relayChunkSize = 256 * 1024;

const now = () => new Date().toISOString();

const updatePlatformKey = () => {
  if (process.platform === 'win32') return 'win32-x64';
  if (process.platform === 'linux') return 'linux-x64';
  return `${process.platform}-${process.arch}`;
};

const normalizeUpdateStatus = (updates = {}) => {
  if (updates.status === 'checking' || updates.status === 'downloading') return 'idle';
  if (updates.status === 'installing') return updates.downloadedPath ? 'ready' : 'idle';
  return updates.status || 'idle';
};

const updateDefaults = (updates = {}, { restoreTransient = false } = {}) => ({
  currentVersion: app.getVersion(),
  platform: updatePlatformKey(),
  status: restoreTransient ? normalizeUpdateStatus(updates) : updates.status || 'idle',
  latestVersion: updates.latestVersion || '',
  checkedAt: updates.checkedAt || '',
  message: updates.message || '',
  downloadUrl: updates.downloadUrl || '',
  fileName: updates.fileName || '',
  sha256: updates.sha256 || '',
  downloadedPath: updates.downloadedPath || '',
  progress: Number.isFinite(updates.progress) ? updates.progress : 0,
});

const makeInitialState = () => {
  const deviceId = crypto.randomUUID();

  return {
    storageNode: {
      name: `${os.hostname()} storage`,
      path: path.join(os.homedir(), 'Nubem Storage'),
      status: 'offline',
      relayStatus: 'offline',
    },
    currentDevice: {
      id: deviceId,
      name: os.hostname(),
      platform: process.platform,
      status: 'online',
    },
    pairing: {
      relayUrl: defaultRelayUrl,
      role: 'client',
      status: 'idle',
    },
    folders: [],
    syncJobs: [],
    activity: [],
    updates: updateDefaults(),
    devices: [
      { id: deviceId, name: os.hostname(), role: 'Client', status: 'online', address: 'Local' },
    ],
  };
};

const normalizeRelayUrl = (value) => {
  const trimmed = String(value || '').trim() || defaultRelayUrl;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, '');
};

const normalizePairCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

const relayStatusFromPairing = (pairing) => {
  if (pairing?.status === 'linked') return 'linked';
  if (pairing?.status === 'waiting') return 'waiting';
  if (pairing?.status === 'error') return 'limited';
  if (pairing?.status === 'ready') return 'ready';
  return 'offline';
};

const storageServiceStatus = () => {
  if (process.platform !== 'linux') {
    return 'offline';
  }

  if (Date.now() - storageServiceStatusCache.checkedAt < 5000) {
    return storageServiceStatusCache.value;
  }

  try {
    const result = spawnSync('systemctl', ['--user', 'is-active', 'nubem-drive-storage.service'], {
      encoding: 'utf8',
      timeout: 1500,
    });
    storageServiceStatusCache = {
      checkedAt: Date.now(),
      value: result.stdout.trim() === 'active' ? 'online' : 'offline',
    };
    return storageServiceStatusCache.value;
  } catch {
    storageServiceStatusCache = { checkedAt: Date.now(), value: 'offline' };
    return 'offline';
  }
};

const runUserSystemctl = (args) => {
  if (process.platform !== 'linux') {
    throw new Error('Server mode is available on Linux');
  }

  const result = spawnSync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    timeout: 10000,
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || 'Server mode failed').trim();
    throw new Error(detail);
  }
};

const normalizeSyncFile = (file = {}) => ({
  sourcePath: String(file.sourcePath || file.path || ''),
  relativePath: String(file.relativePath || ''),
  sizeBytes: Number.isFinite(file.sizeBytes) ? file.sizeBytes : Number(file.size || 0) || 0,
  modifiedAt: String(file.modifiedAt || ''),
  status: ['pending', 'done', 'error'].includes(file.status) ? file.status : 'pending',
  attempts: Number.isFinite(file.attempts) ? file.attempts : 0,
  error: String(file.error || ''),
});

const normalizeSyncJob = (job = {}) => {
  const files = Array.isArray(job.files) ? job.files.map(normalizeSyncFile).filter((file) => file.sourcePath && file.relativePath) : [];
  const completedFiles = files.filter((file) => file.status === 'done').length;

  return {
    id: String(job.id || crypto.randomUUID()),
    type: 'upload-folder',
    vaultFolderId: String(job.vaultFolderId || ''),
    rootPath: String(job.rootPath || ''),
    rootName: String(job.rootName || 'Folder'),
    status: ['queued', 'running', 'complete', 'error'].includes(job.status) ? job.status : 'queued',
    createdAt: String(job.createdAt || now()),
    updatedAt: String(job.updatedAt || now()),
    completedAt: String(job.completedAt || ''),
    nextAttemptAt: String(job.nextAttemptAt || ''),
    lastError: String(job.lastError || ''),
    totalFiles: Number.isFinite(job.totalFiles) ? job.totalFiles : files.length,
    completedFiles,
    totalBytes: Number.isFinite(job.totalBytes) ? job.totalBytes : files.reduce((sum, file) => sum + file.sizeBytes, 0),
    files,
  };
};

const normalizeSyncJobs = (jobs) =>
  Array.isArray(jobs)
    ? jobs.map(normalizeSyncJob).filter((job) => job.vaultFolderId && job.rootPath).slice(0, 128)
    : [];

const normalizeState = (rawState, { restoreUpdates = false } = {}) => {
  const fresh = makeInitialState();
  const state = rawState && typeof rawState === 'object' ? rawState : {};
  const currentDevice = {
    ...fresh.currentDevice,
    ...(state.currentDevice || {}),
  };

  currentDevice.id = currentDevice.id || crypto.randomUUID();
  currentDevice.name = currentDevice.name || os.hostname();
  currentDevice.platform = currentDevice.platform || process.platform;
  currentDevice.status = 'online';

  const pairing = {
    ...fresh.pairing,
    ...(state.pairing || {}),
  };

  pairing.relayUrl = normalizeRelayUrl(pairing.relayUrl);

  const folders = Array.isArray(state.folders)
    ? state.folders.map((folder) => ({
        ...folder,
        vaultRole: folder.vaultRole || (folder.pairId && pairing.role === 'client' ? 'client' : 'storage'),
        relayUrl: normalizeRelayUrl(folder.relayUrl || pairing.relayUrl || defaultRelayUrl),
      }))
    : [];

  const localDevice = {
    id: currentDevice.id,
    name: currentDevice.name,
    role: pairing.role === 'storage' ? 'Server' : 'Client',
    status: 'online',
    address: pairing.status === 'linked' ? 'Relay' : 'Local',
  };
  const devices = Array.isArray(state.devices) ? state.devices.filter((device) => device.id !== currentDevice.id) : [];

  return {
    ...fresh,
    ...state,
    storageNode: {
      ...fresh.storageNode,
      ...(state.storageNode || {}),
      status: storageServiceStatus(),
      relayStatus: relayStatusFromPairing(pairing),
    },
    currentDevice,
    pairing,
    folders,
    syncJobs: normalizeSyncJobs(state.syncJobs),
    activity: Array.isArray(state.activity) ? state.activity : [],
    updates: updateDefaults(state.updates, { restoreTransient: restoreUpdates }),
    devices: [localDevice, ...devices],
  };
};

const ensureState = () => {
  const file = dataFile();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(makeInitialState(), null, 2));
  }

  try {
    const rawState = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const state = normalizeState(JSON.parse(rawState), { restoreUpdates: true });
    writeState(state);
    return state;
  } catch {
    const fresh = makeInitialState();
    fs.writeFileSync(file, JSON.stringify(fresh, null, 2));
    return fresh;
  }
};

const writeState = (state) => {
  const normalized = normalizeState(state);
  fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
  fs.writeFileSync(dataFile(), JSON.stringify(normalized, null, 2));
  return normalized;
};

const makeFolder = (folderPath) => {
  const name = path.basename(folderPath) || folderPath;
  return {
    id: crypto.randomUUID(),
    name,
    path: folderPath,
    vaultRole: 'storage',
    relayUrl: defaultRelayUrl,
    sizeLabel: 'Scanning',
    itemCount: 0,
    updatedAt: now(),
    status: 'queued',
    localMode: 'mirror',
    devices: ['This PC'],
    progress: 0,
  };
};

const addActivity = (state, type, label, detail) => ({
  ...state,
  activity: [
    { id: crypto.randomUUID(), type, label, detail, at: now() },
    ...state.activity,
  ].slice(0, 16),
});

const localRelayDevice = (state, role = state.pairing.role) => ({
  id: state.currentDevice.id,
  name: state.currentDevice.name,
  platform: state.currentDevice.platform,
  role: role || 'client',
});

const relayRequest = async (relayUrl, endpoint, body) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(`${normalizeRelayUrl(relayUrl)}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `Relay ${response.status}`);
    }

    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Relay timeout');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const mapRelayDevice = (device, currentDeviceId) => ({
  id: device.id,
  name: device.name || 'Device',
  role: device.role === 'storage' ? 'Server' : 'Client',
  status: device.status || 'offline',
  address: device.id === currentDeviceId ? 'This PC' : 'Relay',
});

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
};

const publicCloudFolders = (state) =>
  state.folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    path: folder.name,
    sizeLabel: folder.sizeLabel === 'Scanning' ? 'Cloud' : folder.sizeLabel,
    itemCount: folder.itemCount,
    updatedAt: folder.updatedAt,
    status: folder.status === 'paused' ? 'paused' : 'synced',
    localMode: 'online',
    devices: [state.currentDevice.name],
    progress: 100,
  }));

const publicVaultFolder = (state, folder) => ({
  id: folder.id,
  name: folder.name,
  path: folder.name,
  sizeLabel: folder.sizeLabel === 'Scanning' ? 'Cloud' : folder.sizeLabel,
  itemCount: folder.itemCount,
  updatedAt: folder.updatedAt,
  status: folder.status === 'paused' ? 'paused' : 'synced',
  localMode: 'online',
  devices: [state.currentDevice.name],
  progress: 100,
});

const remoteFoldersFromPayload = (payload) =>
  Array.isArray(payload.folders)
    ? payload.folders.map((folder) => ({
        ...folder,
        path: folder.path || folder.name,
        sizeLabel: folder.sizeLabel || 'Cloud',
        itemCount: Number.isFinite(folder.itemCount) ? folder.itemCount : 0,
        updatedAt: folder.updatedAt || now(),
        status: folder.status || 'synced',
        localMode: 'online',
        devices: folder.devices?.length ? folder.devices : [payload.storageName || 'Storage PC'],
        progress: Number.isFinite(folder.progress) ? folder.progress : 100,
      }))
    : null;

const applyRelaySnapshot = (state, payload, status = 'linked') => {
  const devices = Array.isArray(payload.devices)
    ? payload.devices.map((device) => mapRelayDevice(device, state.currentDevice.id))
    : state.devices;
  const remoteFolders = state.pairing.role === 'client' ? remoteFoldersFromPayload(payload) : null;
  const hasOtherDevice = devices.some((device) => device.id !== state.currentDevice.id);
  const nextStatus = status === 'waiting' && hasOtherDevice ? 'linked' : status;
  const nextPairing = {
    ...state.pairing,
    status: nextStatus,
    message: '',
    lastSeenAt: now(),
    storageName: payload.storageName || state.pairing.storageName,
  };
  const pairCodeExpiresAt = payload.expiresAt || payload.pairCodeExpiresAt;

  if (payload.code) {
    nextPairing.pairCode = payload.code;
    nextPairing.pairCodeExpiresAt = pairCodeExpiresAt;
  }

  if (
    payload.code === '' ||
    (pairCodeExpiresAt && new Date(pairCodeExpiresAt).getTime() <= Date.now())
  ) {
    delete nextPairing.pairCode;
    delete nextPairing.pairCodeExpiresAt;
  }

  return writeState({
    ...state,
    pairing: nextPairing,
    devices,
    folders: remoteFolders || state.folders,
  });
};

const markRelayError = (state, message) =>
  writeState({
    ...state,
    pairing: {
      ...state.pairing,
      status: 'error',
      message,
    },
  });

const applyVaultPayloadToFolder = (state, folderId, payload, vaultRole) =>
  writeState({
    ...state,
    folders: state.folders.map((folder) => {
      if (folder.id !== folderId) return folder;
      const remoteFolder = Array.isArray(payload.folders) ? payload.folders[0] : null;
      return {
        ...folder,
        ...(remoteFolder && vaultRole === 'client'
          ? {
              name: remoteFolder.name || folder.name,
              path: remoteFolder.path || remoteFolder.name || folder.path,
              sizeLabel: remoteFolder.sizeLabel || folder.sizeLabel,
              itemCount: Number.isFinite(remoteFolder.itemCount) ? remoteFolder.itemCount : folder.itemCount,
              updatedAt: remoteFolder.updatedAt || folder.updatedAt,
              status: remoteFolder.status || folder.status,
              localMode: 'online',
              devices: remoteFolder.devices?.length ? remoteFolder.devices : [payload.storageName || 'Storage PC'],
              progress: Number.isFinite(remoteFolder.progress) ? remoteFolder.progress : folder.progress,
            }
          : {}),
        vaultRole,
        relayUrl: normalizeRelayUrl(folder.relayUrl || state.pairing.relayUrl || defaultRelayUrl),
        pairId: payload.pairId || folder.pairId,
        token: payload.token || folder.token,
        code: payload.code || folder.code,
        codeExpiresAt: payload.expiresAt || folder.codeExpiresAt,
        storageName: payload.storageName || folder.storageName,
      };
    }),
    devices: Array.isArray(payload.devices)
      ? payload.devices.map((device) => mapRelayDevice(device, state.currentDevice.id))
      : state.devices,
  });

const shareVault = async (folderId, relayUrl = defaultRelayUrl) => {
  const state = ensureState();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) {
    throw new Error('Vault not found');
  }

  if (folder.pairId && folder.token && folder.code) {
    return state;
  }

  const nextRelayUrl = normalizeRelayUrl(relayUrl || folder.relayUrl || defaultRelayUrl);
  const payload = await relayRequest(nextRelayUrl, '/api/drive/vaults/create', {
    device: localRelayDevice(state, 'storage'),
    folder: publicVaultFolder(state, folder),
  });

  const nextState = applyVaultPayloadToFolder(
    {
      ...state,
      folders: state.folders.map((item) =>
        item.id === folder.id ? { ...item, relayUrl: nextRelayUrl, vaultRole: 'storage' } : item
      ),
    },
    folder.id,
    payload,
    'storage'
  );

  return writeState(addActivity(nextState, 'vault', folder.name, payload.code || 'Shared'));
};

const ensureStorageVaultsShared = async () => {
  let state = ensureState();
  const storageFolders = state.folders.filter((folder) => folder.vaultRole !== 'client' && !folder.pairId);

  for (const folder of storageFolders) {
    try {
      state = await shareVault(folder.id, folder.relayUrl || state.pairing.relayUrl || defaultRelayUrl);
    } catch {
      state = ensureState();
    }
  }

  return state;
};

const refreshPairingState = async () => {
  let state = await ensureStorageVaultsShared();
  const vaults = state.folders.filter((folder) => folder.pairId && folder.token);

  if (vaults.length === 0 && (!state.pairing.pairId || !state.pairing.token)) {
    return state;
  }

  for (const folder of vaults) {
    try {
      const payload = await relayRequest(folder.relayUrl || defaultRelayUrl, '/api/drive/heartbeat', {
        pairId: folder.pairId,
        token: folder.token,
        device: localRelayDevice(state, folder.vaultRole || 'storage'),
        folders: folder.vaultRole === 'storage' ? [publicVaultFolder(state, folder)] : undefined,
      });
      state = applyVaultPayloadToFolder(state, folder.id, payload, folder.vaultRole || 'storage');
      if (folder.vaultRole === 'storage') {
        handlePendingRelayRequests(folder.id).catch(() => undefined);
      }
    } catch (error) {
      state = writeState({
        ...ensureState(),
        folders: ensureState().folders.map((item) =>
          item.id === folder.id
            ? { ...item, status: 'offline', updatedAt: now() }
            : item
        ),
      });
    }
  }

  if (!state.pairing.pairId || !state.pairing.token) {
    return state;
  }

  try {
    const payload = await relayRequest(state.pairing.relayUrl, '/api/drive/heartbeat', {
      pairId: state.pairing.pairId,
      token: state.pairing.token,
      device: localRelayDevice(state),
      folders: state.pairing.role === 'storage' ? publicCloudFolders(state) : undefined,
    });
    const nextState = applyRelaySnapshot(state, payload, state.pairing.role === 'storage' ? 'waiting' : 'linked');
    return nextState;
  } catch (error) {
    return markRelayError(state, error instanceof Error ? error.message : 'Relay offline');
  }
};

const createPairCode = async (relayUrl) => {
  const state = ensureState();
  const nextRelayUrl = normalizeRelayUrl(relayUrl);
  const payload = await relayRequest(nextRelayUrl, '/api/drive/pair-codes', {
    device: localRelayDevice(state, 'storage'),
    folders: publicCloudFolders(state),
  });
  const nextState = addActivity(
    {
      ...state,
      pairing: {
        relayUrl: nextRelayUrl,
        role: 'storage',
        status: 'waiting',
        pairCode: payload.code,
        pairCodeExpiresAt: payload.expiresAt,
        pairId: payload.pairId,
        token: payload.token,
        storageName: state.currentDevice.name,
        message: '',
      },
    },
    'link',
    'Pair code',
    payload.code
  );

  return applyRelaySnapshot(writeState(nextState), payload, 'waiting');
};

const joinPairing = async (relayUrl, code) => {
  const state = ensureState();
  const cleanCode = normalizePairCode(code);
  if (cleanCode.length !== 12 && !/^\d{6}$/.test(cleanCode)) {
    throw new Error('Use the code shown');
  }

  const nextRelayUrl = normalizeRelayUrl(relayUrl);
  const payload = await relayRequest(nextRelayUrl, '/api/drive/vaults/join', {
    code: cleanCode,
    device: localRelayDevice(state, 'client'),
  });
  const remoteFolder = Array.isArray(payload.folders) ? payload.folders[0] : null;
  const folderId = remoteFolder?.id || payload.vault?.id || crypto.randomUUID();
  const known = state.folders.some((folder) => folder.pairId === payload.pairId || folder.id === folderId);
  const joinedVault = {
    id: folderId,
    name: remoteFolder?.name || payload.vault?.name || payload.storageName || 'Vault',
    path: remoteFolder?.path || remoteFolder?.name || 'Vault',
    vaultRole: 'client',
    relayUrl: nextRelayUrl,
    pairId: payload.pairId,
    token: payload.token,
    storageName: payload.storageName,
    sizeLabel: remoteFolder?.sizeLabel || 'Cloud',
    itemCount: Number.isFinite(remoteFolder?.itemCount) ? remoteFolder.itemCount : 0,
    updatedAt: remoteFolder?.updatedAt || now(),
    status: remoteFolder?.status || 'synced',
    localMode: 'online',
    devices: remoteFolder?.devices?.length ? remoteFolder.devices : [payload.storageName || 'Storage PC'],
    progress: 100,
  };
  const nextState = addActivity(
    {
      ...state,
      folders: known ? state.folders : [joinedVault, ...state.folders],
      pairing: {
        relayUrl: nextRelayUrl,
        role: state.pairing.role || 'client',
        status: 'linked',
        storageName: payload.storageName,
        message: '',
      },
    },
    'link',
    'Linked',
    payload.storageName || 'Storage PC'
  );

  return writeState(nextState);
};

const resetPairing = () => {
  const state = ensureState();
  return writeState(
    addActivity(
      {
        ...state,
        pairing: {
          relayUrl: state.pairing.relayUrl || defaultRelayUrl,
          role: 'client',
          status: 'idle',
        },
      },
      'link',
      'Link reset',
      'Ready'
    )
  );
};

const setServerMode = async (enabled) => {
  runUserSystemctl(['daemon-reload']);
  runUserSystemctl([enabled ? 'enable' : 'disable', '--now', 'nubem-drive-storage.service']);
  storageServiceStatusCache = { checkedAt: 0, value: 'offline' };

  const state = ensureState();
  const relayUrl = state.pairing.relayUrl || defaultRelayUrl;
  const pairing = enabled
    ? {
        relayUrl,
        role: 'storage',
        status: 'idle',
        storageName: state.currentDevice.name,
        message: '',
      }
    : {
        relayUrl,
        role: 'client',
        status: 'idle',
        message: '',
      };

  return writeState(
    addActivity(
      {
        ...state,
        pairing,
      },
      'link',
      enabled ? 'Server mode' : 'Client mode',
      enabled ? 'On' : 'Off'
    )
  );
};

const processingRelayRequests = new Set();
const deleteRequestPrefix = '.nubem-command/delete/';
const relayRequestLockTtlMs = 10 * 60 * 1000;

const relayLockRoot = () => path.join(path.dirname(dataFile()), 'relay-locks');

const acquireRelayRequestLock = (requestId) => {
  if (processingRelayRequests.has(requestId)) {
    return false;
  }

  const lockPath = path.join(relayLockRoot(), requestId);
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.mkdirSync(lockPath);
    processingRelayRequests.add(requestId);
    return true;
  } catch {
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtime.getTime() > relayRequestLockTtlMs) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        fs.mkdirSync(lockPath);
        processingRelayRequests.add(requestId);
        return true;
      }
    } catch {
      return false;
    }

    return false;
  }
};

const releaseRelayRequestLock = (requestId) => {
  processingRelayRequests.delete(requestId);
  fs.rmSync(path.join(relayLockRoot(), requestId), { recursive: true, force: true });
};

const encodeDeleteRequestPath = (relativePath) =>
  `${deleteRequestPrefix}${Buffer.from(relativePath, 'utf8').toString('base64url')}`;

const decodeDeleteRequestPath = (request) => {
  if (request.type === 'delete') {
    return request.relativePath;
  }

  const relativePath = String(request.relativePath || '');
  if (request.type !== 'list' || !relativePath.startsWith(deleteRequestPrefix)) {
    return '';
  }

  try {
    return Buffer.from(relativePath.slice(deleteRequestPrefix.length), 'base64url').toString('utf8');
  } catch {
    return '';
  }
};

const getPairCredentials = () => {
  const state = ensureState();
  if (!state.pairing.pairId || !state.pairing.token) {
    throw new Error('Not linked');
  }

  return {
    state,
    pairId: state.pairing.pairId,
    token: state.pairing.token,
    relayUrl: state.pairing.relayUrl,
  };
};

const getVaultCredentials = (folderId) => {
  const state = ensureState();
  const folder = state.folders.find((item) => item.id === folderId);

  if (!folder?.pairId || !folder.token) {
    throw new Error('Vault not linked');
  }

  return {
    state,
    folder,
    pairId: folder.pairId,
    token: folder.token,
    relayUrl: folder.relayUrl || defaultRelayUrl,
  };
};

const validateRelativePath = (relativePath = '') => {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);

  if (path.isAbsolute(normalized) || parts.some((part) => part === '..') || normalized.includes('\0')) {
    throw new Error('Invalid path');
  }

  return parts.join(path.sep);
};

const resolveCloudPath = (state, folderId, relativePath = '') => {
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) {
    throw new Error('Folder not found');
  }

  const root = path.resolve(folder.path);
  const safeRelativePath = validateRelativePath(relativePath);
  const target = path.resolve(root, safeRelativePath || '.');

  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Path outside folder');
  }

  return { folder, root, target };
};

const relativeCloudPath = (root, target) => path.relative(root, target).split(path.sep).filter(Boolean).join('/');

const listCloudFolder = (state, folderId, relativePath = '') => {
  const { root, target } = resolveCloudPath(state, folderId, relativePath);
  const stat = fs.statSync(target);

  if (!stat.isDirectory()) {
    throw new Error('Not a folder');
  }

  const entries = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .slice(0, 600)
    .map((entry) => {
      const fullPath = path.join(target, entry.name);
      const entryStat = fs.statSync(fullPath);

      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        relativePath: relativeCloudPath(root, fullPath),
        sizeBytes: entry.isDirectory() ? 0 : entryStat.size,
        sizeLabel: entry.isDirectory() ? '' : formatBytes(entryStat.size),
        modifiedAt: entryStat.mtime.toISOString(),
      };
    })
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

  const currentPath = relativeCloudPath(root, target);
  const parentPath = currentPath ? currentPath.split('/').slice(0, -1).join('/') : '';

  return {
    folderId,
    path: currentPath,
    parentPath,
    entries,
  };
};

const statCloudPath = (state, folderId, relativePath = '') => {
  const { root, target } = resolveCloudPath(state, folderId, relativePath);
  const stat = fs.statSync(target);
  const type = stat.isDirectory() ? 'directory' : 'file';

  return {
    exists: true,
    name: path.basename(target),
    type,
    relativePath: relativeCloudPath(root, target),
    sizeBytes: type === 'file' ? stat.size : 0,
    sizeLabel: type === 'file' ? formatBytes(stat.size) : '',
    modifiedAt: stat.mtime.toISOString(),
  };
};

const createRelayRequest = async (type, folderId, relativePath) => {
  const { pairId, relayUrl, token } = getVaultCredentials(folderId);
  const payload = await relayRequest(relayUrl, '/api/drive/requests/create', {
    pairId,
    token,
    type,
    folderId,
    relativePath,
  });

  return payload.requestId;
};

const waitForRelayRequest = async (requestId, timeoutMs = 120000) => {
  const startedAt = Date.now();
  const state = ensureState();
  const folder = state.folders.find((item) => item.pairId && item.token);
  const { pairId, relayUrl, token } = getVaultCredentials(folder?.id);

  while (Date.now() - startedAt < timeoutMs) {
    const payload = await relayRequest(relayUrl, '/api/drive/requests/result', {
      pairId,
      token,
      requestId,
    });

    if (payload.status === 'ready') {
      return payload.result;
    }

    if (payload.status === 'error') {
      throw new Error(payload.error || 'Remote request failed');
    }

    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  throw new Error('Storage PC did not respond');
};

const waitForVaultRequest = async (folderId, requestId, timeoutMs = 120000) => {
  const startedAt = Date.now();
  const { pairId, relayUrl, token } = getVaultCredentials(folderId);

  while (Date.now() - startedAt < timeoutMs) {
    const payload = await relayRequest(relayUrl, '/api/drive/requests/result', {
      pairId,
      token,
      requestId,
    });

    if (payload.status === 'ready') {
      return payload.result;
    }

    if (payload.status === 'error') {
      throw new Error(payload.error || 'Remote request failed');
    }

    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  throw new Error('Storage PC did not respond');
};

const completeRelayRequest = async (folderId, requestId, result, error) => {
  const { pairId, relayUrl, token } = getVaultCredentials(folderId);
  return relayRequest(relayUrl, '/api/drive/requests/complete', {
    pairId,
    token,
    requestId,
    result,
    error,
  });
};

const uploadRelayChunk = async (folderId, requestId, index, data) => {
  const { pairId, relayUrl, token } = getVaultCredentials(folderId);
  return relayRequest(relayUrl, '/api/drive/requests/chunk', {
    pairId,
    token,
    requestId,
    index,
    data,
  });
};

const markUploadReady = async (folderId, requestId) => {
  const { pairId, relayUrl, token } = getVaultCredentials(folderId);
  return relayRequest(relayUrl, '/api/drive/requests/upload-ready', {
    pairId,
    token,
    requestId,
  });
};

const failUploadRequest = async (folderId, requestId, error) => {
  const { pairId, relayUrl, token } = getVaultCredentials(folderId);
  return relayRequest(relayUrl, '/api/drive/requests/fail', {
    pairId,
    token,
    requestId,
    error,
  });
};

const downloadRelayChunk = async (folderId, requestId, index) => {
  const { pairId, relayUrl, token } = getVaultCredentials(folderId);
  return relayRequest(relayUrl, '/api/drive/requests/chunk', {
    pairId,
    token,
    requestId,
    index,
  });
};

const sendFileToRelay = async (requestId, folderId, relativePath) => {
  const state = ensureState();
  const { target } = resolveCloudPath(state, folderId, relativePath);
  const stat = fs.statSync(target);

  if (!stat.isFile()) {
    throw new Error('Not a file');
  }

  const chunkSize = relayChunkSize;
  const file = fs.openSync(target, 'r');
  const buffer = Buffer.alloc(chunkSize);
  let index = 0;
  let offset = 0;

  try {
    while (offset < stat.size) {
      const bytesRead = fs.readSync(file, buffer, 0, Math.min(chunkSize, stat.size - offset), offset);
      if (bytesRead <= 0) break;
      await uploadRelayChunk(folderId, requestId, index, buffer.subarray(0, bytesRead).toString('base64'));
      offset += bytesRead;
      index += 1;
    }
  } finally {
    fs.closeSync(file);
  }

  return {
    fileName: path.basename(target),
    totalBytes: stat.size,
    sizeLabel: formatBytes(stat.size),
    chunkCount: index,
    modifiedAt: stat.mtime.toISOString(),
  };
};

const receiveFileFromRelay = async (vaultFolderId, request) => {
  const state = ensureState();
  const { target } = resolveCloudPath(state, vaultFolderId, request.relativePath);
  const modifiedAt = request.modifiedAt ? new Date(request.modifiedAt) : null;

  if (fs.existsSync(target)) {
    const current = fs.statSync(target);
    const remoteTime = modifiedAt && Number.isFinite(modifiedAt.getTime()) ? modifiedAt.getTime() : 0;
    if (current.isFile() && current.size === Number(request.totalBytes || 0) && (!remoteTime || Math.abs(current.mtime.getTime() - remoteTime) < 2000)) {
      return {
        fileName: path.basename(target),
        relativePath: request.relativePath,
        totalBytes: current.size,
        sizeLabel: formatBytes(current.size),
        skipped: true,
        writtenAt: now(),
      };
    }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmpTarget = `${target}.nubem-part-${request.id}`;

  const stream = fs.createWriteStream(tmpTarget);
  try {
    for (let index = 0; index < Number(request.chunkCount || 0); index += 1) {
      const chunk = await downloadRelayChunk(vaultFolderId, request.id, index);
      stream.write(Buffer.from(chunk.data, 'base64'));
    }
  } finally {
    await new Promise((resolve, reject) => {
      stream.end((error) => (error ? reject(error) : resolve()));
    });
  }

  fs.renameSync(tmpTarget, target);
  if (modifiedAt && Number.isFinite(modifiedAt.getTime())) {
    fs.utimesSync(target, modifiedAt, modifiedAt);
  }

  const stat = fs.statSync(target);
  return {
    fileName: path.basename(target),
    relativePath: request.relativePath,
    totalBytes: stat.size,
    sizeLabel: formatBytes(stat.size),
    writtenAt: now(),
  };
};

const handlePendingRelayRequests = async (vaultFolderId) => {
  const state = ensureState();
  const folder = state.folders.find((item) => item.id === vaultFolderId);
  if (!folder || folder.vaultRole !== 'storage' || !folder.pairId || !folder.token) {
    return;
  }

  const payload = await relayRequest(folder.relayUrl || defaultRelayUrl, '/api/drive/requests/poll', {
    pairId: folder.pairId,
    token: folder.token,
  });

  for (const request of payload.requests || []) {
    if (!acquireRelayRequestLock(request.id)) {
      continue;
    }

    try {
      const deleteRelativePath = decodeDeleteRequestPath(request);
      let result;
      if (deleteRelativePath) {
        result = deleteCloudPath(ensureState(), vaultFolderId, deleteRelativePath);
      } else if (request.type === 'download') {
        result = await sendFileToRelay(request.id, vaultFolderId, request.relativePath);
      } else if (request.type === 'upload') {
        result = await receiveFileFromRelay(vaultFolderId, request);
      } else if (request.type === 'delete') {
        result = deleteCloudPath(ensureState(), vaultFolderId, request.relativePath);
      } else if (request.type === 'stat') {
        result = statCloudPath(ensureState(), vaultFolderId, request.relativePath);
      } else {
        result = listCloudFolder(ensureState(), vaultFolderId, request.relativePath);
      }
      await completeRelayRequest(vaultFolderId, request.id, result);
    } catch (error) {
      await completeRelayRequest(vaultFolderId, request.id, null, error instanceof Error ? error.message : 'Request failed');
    } finally {
      releaseRelayRequestLock(request.id);
    }
  }
};

const browseRemoteFolder = async (folderId, relativePath = '') => {
  const state = ensureState();
  if (state.pairing.role === 'storage') {
    return listCloudFolder(state, folderId, relativePath);
  }

  const requestId = await createRelayRequest('list', folderId, relativePath);
  return waitForVaultRequest(folderId, requestId);
};

const downloadRemoteFile = async (folderId, relativePath = '') => {
  const state = ensureState();

  if (state.pairing.role === 'storage') {
    const { target } = resolveCloudPath(state, folderId, relativePath);
    shell.showItemInFolder(target);
    return { ok: true, filePath: target };
  }

  const requestId = await createRelayRequest('download', folderId, relativePath);
  const result = await waitForVaultRequest(folderId, requestId, 15 * 60 * 1000);
  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: 'Save from Nubem Drive',
    defaultPath: result.fileName,
  });

  if (saveResult.canceled || !saveResult.filePath) {
    return { ok: false };
  }

  const stream = fs.createWriteStream(saveResult.filePath);

  try {
    for (let index = 0; index < result.chunkCount; index += 1) {
      const chunk = await downloadRelayChunk(folderId, requestId, index);
      stream.write(Buffer.from(chunk.data, 'base64'));
    }
  } finally {
    await new Promise((resolve, reject) => {
      stream.end((error) => (error ? reject(error) : resolve()));
    });
  }

  writeState(addActivity(ensureState(), 'download', result.fileName, result.sizeLabel || 'Downloaded'));
  return { ok: true, filePath: saveResult.filePath };
};

const deleteCloudPath = (state, folderId, relativePath = '') => {
  const safeRelativePath = validateRelativePath(relativePath);
  if (!safeRelativePath) {
    throw new Error('Select a file or folder');
  }

  const { root, target } = resolveCloudPath(state, folderId, safeRelativePath);
  if (target === root) {
    throw new Error('Cannot remove the vault root');
  }

  const stat = fs.lstatSync(target);
  const kind = stat.isDirectory() && !stat.isSymbolicLink() ? 'folder' : 'file';
  fs.rmSync(target, { recursive: kind === 'folder', force: false });

  return {
    name: path.basename(target),
    relativePath: safeRelativePath.split(path.sep).join('/'),
    type: kind,
    deletedAt: now(),
  };
};

const requireDeleteResult = (result) => {
  if (result?.deletedAt && (result.type === 'file' || result.type === 'folder') && result.relativePath) {
    return result;
  }

  throw new Error('Storage PC needs the latest Nubem Drive to delete from vault');
};

const deleteVaultRelativePath = async (folderId, relativePath = '', timeoutMs = 15 * 60 * 1000) => {
  const safeRelativePath = validateRelativePath(relativePath).split(path.sep).join('/');
  if (!safeRelativePath) {
    throw new Error('Select a file or folder');
  }

  const state = ensureState();
  return requireDeleteResult(
    state.pairing.role === 'storage'
      ? deleteCloudPath(state, folderId, safeRelativePath)
      : await waitForVaultRequest(folderId, await createRelayRequest('list', folderId, encodeDeleteRequestPath(safeRelativePath)), timeoutMs)
  );
};

const deleteRemoteEntry = async (folderId, relativePath = '') => {
  const safeRelativePath = validateRelativePath(relativePath).split(path.sep).join('/');
  if (!safeRelativePath) {
    throw new Error('Select a file or folder');
  }

  const name = path.basename(safeRelativePath);
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Delete from vault',
    message: `Delete "${name}" from the vault?`,
    detail: 'This removes it from the storage PC for every paired device.',
  });

  if (result.response !== 0) {
    return { ok: false, canceled: true };
  }

  const deleteResult = await deleteVaultRelativePath(folderId, safeRelativePath);
  writeState(addActivity(ensureState(), 'remove', deleteResult.name || name, 'Deleted from vault'));
  return { ok: true, deleted: deleteResult };
};

const findDefaultClientVault = (state) => state.folders.find((folder) => folder.vaultRole === 'client' && folder.pairId && folder.token);

const walkFiles = (root) => {
  const files = [];
  const visit = (target) => {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) {
        visit(path.join(target, entry));
      }
      return;
    }

    if (stat.isFile()) {
      files.push({
        sourcePath: target,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  };

  visit(root);
  return files;
};

const createUploadRequest = async (vaultFolderId, relativePath, fileName, totalBytes, chunkCount, modifiedAt = '') => {
  const { pairId, relayUrl, token } = getVaultCredentials(vaultFolderId);
  const payload = await relayRequest(relayUrl, '/api/drive/requests/create', {
    pairId,
    token,
    type: 'upload',
    folderId: vaultFolderId,
    relativePath,
    fileName,
    totalBytes,
    sizeLabel: formatBytes(totalBytes),
    chunkCount,
    modifiedAt,
  });

  return payload.requestId;
};

const uploadFileToVault = async (vaultFolderId, sourceFile, targetRelativePath, metadata = {}) => {
  const stat = fs.statSync(sourceFile);
  const chunkSize = relayChunkSize;
  const chunkCount = Math.max(1, Math.ceil(stat.size / chunkSize));
  const modifiedAt = metadata.modifiedAt || stat.mtime.toISOString();
  let requestId = '';
  let file;
  const buffer = Buffer.alloc(chunkSize);
  let index = 0;
  let offset = 0;

  try {
    file = fs.openSync(sourceFile, 'r');
    requestId = await createUploadRequest(vaultFolderId, targetRelativePath, path.basename(sourceFile), stat.size, chunkCount, modifiedAt);

    if (stat.size === 0) {
      await uploadRelayChunk(vaultFolderId, requestId, 0, Buffer.alloc(0).toString('base64'));
    }

    while (offset < stat.size) {
      const bytesRead = fs.readSync(file, buffer, 0, Math.min(chunkSize, stat.size - offset), offset);
      if (bytesRead <= 0) break;
      await uploadRelayChunk(vaultFolderId, requestId, index, buffer.subarray(0, bytesRead).toString('base64'));
      offset += bytesRead;
      index += 1;
    }

    await markUploadReady(vaultFolderId, requestId);
    return await waitForVaultRequest(vaultFolderId, requestId, 15 * 60 * 1000);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload failed';
    if (requestId) {
      await failUploadRequest(vaultFolderId, requestId, message).catch(() => undefined);
    }

    throw new Error(`${path.basename(sourceFile)}: ${message}`);
  } finally {
    if (file !== undefined) {
      fs.closeSync(file);
    }
  }
};

const makeUploadJob = (vaultFolderId, folderPath) => {
  const root = path.resolve(folderPath);
  const rootName = path.basename(root) || 'Folder';
  const files = walkFiles(root).map((file) => ({
    ...file,
    relativePath: [rootName, relativeCloudPath(root, file.sourcePath)].filter(Boolean).join('/'),
    status: 'pending',
    attempts: 0,
    error: '',
  }));

  return normalizeSyncJob({
    id: crypto.randomUUID(),
    type: 'upload-folder',
    vaultFolderId,
    rootPath: root,
    rootName,
    status: files.length > 0 ? 'queued' : 'complete',
    createdAt: now(),
    updatedAt: now(),
    completedAt: files.length > 0 ? '' : now(),
    totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    files,
  });
};

const syncJobProgress = (job) => {
  const completedFiles = job.files.filter((file) => file.status === 'done').length;
  const totalFiles = Math.max(job.files.length, job.totalFiles, 0);
  return {
    completedFiles,
    totalFiles,
    progress: totalFiles === 0 ? 100 : Math.round((completedFiles / totalFiles) * 100),
  };
};

const applyVaultSyncStatus = (state, vaultFolderId) => {
  const activeJobs = state.syncJobs.filter((job) => job.vaultFolderId === vaultFolderId && job.status !== 'complete');
  const completedJobs = state.syncJobs.filter((job) => job.vaultFolderId === vaultFolderId && job.status === 'complete');
  const totalFiles = activeJobs.reduce((sum, job) => sum + Math.max(job.totalFiles, job.files.length), 0);
  const completedFiles = activeJobs.reduce((sum, job) => sum + syncJobProgress(job).completedFiles, 0);
  const isRunning = activeJobs.some((job) => job.status === 'running');
  const hasQueued = activeJobs.length > 0;

  return {
    ...state,
    folders: state.folders.map((folder) => {
      if (folder.id !== vaultFolderId || folder.vaultRole !== 'client') {
        return folder;
      }

      if (!hasQueued) {
        return {
          ...folder,
          status: folder.status === 'paused' ? 'paused' : 'synced',
          progress: 100,
          updatedAt: completedJobs.length > 0 ? now() : folder.updatedAt,
        };
      }

      return {
        ...folder,
        status: isRunning ? 'syncing' : 'queued',
        progress: totalFiles === 0 ? 100 : Math.round((completedFiles / totalFiles) * 100),
        updatedAt: now(),
      };
    }),
  };
};

const updateSyncJob = (jobId, updater) => {
  const state = ensureState();
  let changedJob = null;
  const syncJobs = state.syncJobs.map((job) => {
    if (job.id !== jobId) return job;
    changedJob = normalizeSyncJob({
      ...updater(job),
      updatedAt: now(),
    });
    return changedJob;
  });

  if (!changedJob) {
    return state;
  }

  return writeState(applyVaultSyncStatus({ ...state, syncJobs }, changedJob.vaultFolderId));
};

const updateSyncFile = (jobId, relativePath, patch, jobPatch = {}) =>
  updateSyncJob(jobId, (job) => ({
    ...job,
    ...jobPatch,
    files: job.files.map((file) => (file.relativePath === relativePath ? { ...file, ...patch } : file)),
  }));

const markSyncFileDone = (jobId, file, patch = {}) =>
  updateSyncFile(
    jobId,
    file.relativePath,
    {
      ...patch,
      status: 'done',
      error: '',
    },
    {
      lastError: '',
      nextAttemptAt: '',
    }
  );

const markSyncFileRetry = (jobId, file, message) => {
  const attempts = Number(file.attempts || 0) + 1;
  const delayMs = Math.min(5 * 60 * 1000, 10_000 * attempts);
  return updateSyncFile(
    jobId,
    file.relativePath,
    {
      status: 'pending',
      attempts,
      error: message,
    },
    {
      status: 'queued',
      lastError: message,
      nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
    }
  );
};

const finishSyncJob = (jobId) => {
  const state = updateSyncJob(jobId, (job) => ({
    ...job,
    status: 'complete',
    completedAt: now(),
    lastError: '',
    nextAttemptAt: '',
  }));
  const job = state.syncJobs.find((item) => item.id === jobId);
  if (job) {
    writeState(addActivity(ensureState(), 'upload', job.rootName, `${syncJobProgress(job).totalFiles} files uploaded`));
  }
  return ensureState();
};

const enqueueUploadJobs = (state, vaultFolderId, folderPaths) => {
  const existingKeys = new Set(
    state.syncJobs
      .filter((job) => job.status !== 'complete')
      .map((job) => `${job.vaultFolderId}:${path.resolve(job.rootPath)}`)
  );
  const jobs = [];

  for (const folderPath of resolveDirectoryPaths(folderPaths)) {
    const root = path.resolve(folderPath);
    const key = `${vaultFolderId}:${root}`;
    if (existingKeys.has(key)) {
      continue;
    }

    const job = makeUploadJob(vaultFolderId, root);
    jobs.push(job);
    existingKeys.add(key);
  }

  if (jobs.length === 0) {
    return { state, jobs };
  }

  const fileCount = jobs.reduce((sum, job) => sum + job.totalFiles, 0);
  const nextState = addActivity(
    applyVaultSyncStatus(
      {
        ...state,
        syncJobs: [...state.syncJobs, ...jobs],
      },
      vaultFolderId
    ),
    'upload',
    jobs.length === 1 ? jobs[0].rootName : `${jobs.length} folders`,
    `${fileCount} files queued`
  );

  return { state: writeState(nextState), jobs };
};

const statRemotePath = async (vaultFolderId, relativePath) => {
  const requestId = await createRelayRequest('stat', vaultFolderId, relativePath);
  return waitForVaultRequest(vaultFolderId, requestId, 90_000);
};

const remoteFileMatches = async (vaultFolderId, file) => {
  try {
    const result = await statRemotePath(vaultFolderId, file.relativePath);
    const remoteTime = new Date(result?.modifiedAt || 0).getTime();
    const localTime = new Date(file.modifiedAt || 0).getTime();

    return (
      result?.exists === true &&
      result.type === 'file' &&
      Number(result.sizeBytes || 0) === Number(file.sizeBytes || 0) &&
      (!Number.isFinite(localTime) || !Number.isFinite(remoteTime) || Math.abs(remoteTime - localTime) < 2000)
    );
  } catch {
    return false;
  }
};

const nextRunnableSyncJob = () => {
  const state = ensureState();
  const currentTime = Date.now();
  return state.syncJobs.find((job) => {
    if (job.status === 'complete' || job.status === 'error') return false;
    if (!job.nextAttemptAt) return true;
    return new Date(job.nextAttemptAt).getTime() <= currentTime;
  });
};

const processUploadJob = async (jobId) => {
  let state = updateSyncJob(jobId, (job) => ({
    ...job,
    status: 'running',
    lastError: '',
    nextAttemptAt: '',
  }));

  while (true) {
    state = ensureState();
    const job = state.syncJobs.find((item) => item.id === jobId);
    if (!job || job.status === 'complete') {
      return ensureState();
    }

    const vault = state.folders.find((folder) => folder.id === job.vaultFolderId && folder.vaultRole === 'client');
    if (!vault) {
      return updateSyncJob(jobId, (current) => ({
        ...current,
        status: 'error',
        lastError: 'Vault not linked',
        nextAttemptAt: '',
      }));
    }

    const file = job.files.find((item) => item.status !== 'done');
    if (!file) {
      return finishSyncJob(jobId);
    }

    try {
      if (!fs.existsSync(file.sourcePath)) {
        markSyncFileDone(jobId, file, { error: 'Source missing' });
        continue;
      }

      const stat = fs.statSync(file.sourcePath);
      if (!stat.isFile()) {
        markSyncFileDone(jobId, file, { error: 'Source skipped' });
        continue;
      }

      const currentFile = {
        ...file,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };

      updateSyncFile(jobId, file.relativePath, {
        sizeBytes: currentFile.sizeBytes,
        modifiedAt: currentFile.modifiedAt,
        error: '',
      });

      if (!(await remoteFileMatches(job.vaultFolderId, currentFile))) {
        await uploadFileToVault(job.vaultFolderId, currentFile.sourcePath, currentFile.relativePath, currentFile);
      }

      markSyncFileDone(jobId, currentFile, {
        sizeBytes: currentFile.sizeBytes,
        modifiedAt: currentFile.modifiedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed';
      markSyncFileRetry(jobId, file, message);
      return ensureState();
    }
  }
};

const processUploadJobs = async () => {
  if (syncWork) return syncWork;

  syncWork = (async () => {
    while (true) {
      const job = nextRunnableSyncJob();
      if (!job) {
        return ensureState();
      }

      await processUploadJob(job.id);
    }
  })().finally(() => {
    syncWork = null;
  });

  return syncWork;
};

const startSyncProcessor = () => {
  if (syncTimer) return;

  setTimeout(() => {
    processUploadJobs().catch(() => undefined);
  }, 1000);

  syncTimer = setInterval(() => {
    processUploadJobs().catch(() => undefined);
  }, 5000);
};

const cloudFoldersToDefaultVault = async (folderPaths) => {
  let state = ensureState();
  const vault = findDefaultClientVault(state);

  if (!vault) {
    focusMainWindow();
    throw new Error('Join a vault first');
  }

  const result = enqueueUploadJobs(state, vault.id, folderPaths);
  state = result.state;
  processUploadJobs().catch(() => undefined);

  return state;
};

const removeCloudFoldersFromDefaultVault = async (folderPaths) => {
  let state = ensureState();
  const vault = findDefaultClientVault(state);

  if (!vault) {
    focusMainWindow();
    throw new Error('Join a vault first');
  }

  const roots = resolveDirectoryPaths(folderPaths).map((folderPath) => path.resolve(folderPath));
  const matches = state.syncJobs.filter(
    (job) => job.vaultFolderId === vault.id && roots.includes(path.resolve(job.rootPath))
  );

  if (matches.length === 0) {
    throw new Error('Folder is not clouded');
  }

  const uniqueRoots = Array.from(new Map(matches.map((job) => [job.rootName, job])).values());
  const label = uniqueRoots.length === 1 ? uniqueRoots[0].rootName : `${uniqueRoots.length} folders`;
  const result = await dialog.showMessageBox(createWindow(), {
    type: 'warning',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Remove from cloud',
    message: `Remove "${label}" from the vault?`,
    detail: 'Files stay on this computer. The cloud copy is removed from the storage PC for paired devices.',
  });

  if (result.response !== 0) {
    return ensureState();
  }

  for (const job of uniqueRoots) {
    await deleteVaultRelativePath(vault.id, job.rootName, 120_000);
  }

  state = ensureState();
  const removedJobIds = new Set(matches.map((job) => job.id));
  const nextState = addActivity(
    applyVaultSyncStatus(
      {
        ...state,
        syncJobs: state.syncJobs.filter((job) => !removedJobIds.has(job.id)),
      },
      vault.id
    ),
    'remove',
    label,
    'Removed from cloud'
  );

  return writeState(nextState);
};

const compareVersions = (left, right) => {
  const leftParts = String(left || '0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right || '0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) return diff;
  }

  return 0;
};

const updateMessage = (status, fallback = '') => {
  const copy = {
    idle: '',
    current: 'Up to date',
    checking: 'Checking',
    available: 'Update available',
    downloading: 'Downloading update',
    ready: 'Installing soon',
    installing: 'Installing update',
    error: fallback || 'Update failed',
  };

  return copy[status] || fallback;
};

const writeUpdateState = (patch) => {
  const state = ensureState();
  return writeState({
    ...state,
    updates: updateDefaults({
      ...state.updates,
      ...patch,
    }),
  });
};

const absoluteUpdateUrl = (url) => {
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(url, defaultRelayUrl).toString();
};

const readUpdateManifest = async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${defaultUpdateManifestUrl}?t=${Date.now()}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Update check failed ${response.status}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
};

const selectUpdateAsset = (manifest) => {
  const platform = updatePlatformKey();
  const asset = manifest?.platforms?.[platform];
  if (!asset) return null;
  const rawUrl = String(asset.url || '');
  if (!rawUrl) return null;

  return {
    platform,
    version: String(asset.version || manifest.latest || ''),
    url: absoluteUpdateUrl(rawUrl),
    fileName: String(asset.fileName || path.basename(new URL(absoluteUpdateUrl(rawUrl)).pathname)),
    sha256: String(asset.sha256 || ''),
  };
};

const checkForUpdates = async ({ autoDownload = false, autoInstall = false } = {}) => {
  if (updateWork) return updateWork;

  updateWork = (async () => {
    writeUpdateState({
      status: 'checking',
      checkedAt: now(),
      message: updateMessage('checking'),
    });

    try {
      const manifest = await readUpdateManifest();
      const asset = selectUpdateAsset(manifest);
      const currentVersion = app.getVersion();

      if (!asset || !asset.url || compareVersions(asset.version, currentVersion) <= 0) {
        return writeUpdateState({
          status: 'current',
          latestVersion: asset?.version || currentVersion,
          checkedAt: now(),
          message: updateMessage('current'),
          downloadUrl: '',
          fileName: '',
          sha256: '',
          downloadedPath: '',
          progress: 0,
        });
      }

      const nextState = writeUpdateState({
        status: 'available',
        latestVersion: asset.version,
        checkedAt: now(),
        message: updateMessage('available'),
        downloadUrl: asset.url,
        fileName: asset.fileName,
        sha256: asset.sha256,
        downloadedPath: '',
        progress: 0,
      });

      if (autoDownload || autoInstall) {
        updateWork = null;
        return downloadUpdate({ autoInstall });
      }

      return nextState;
    } catch (error) {
      return writeUpdateState({
        status: 'error',
        checkedAt: now(),
        message: error instanceof Error ? error.message : updateMessage('error'),
      });
    } finally {
      updateWork = null;
    }
  })();

  return updateWork;
};

const sha256File = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });

const downloadUpdate = async ({ autoInstall = false } = {}) => {
  if (updateWork) return updateWork;

  const state = ensureState();
  if (!state.updates.downloadUrl) {
    return checkForUpdates({ autoDownload: true, autoInstall });
  }

  updateWork = (async () => {
    if (!state.updates.downloadUrl || state.updates.status === 'current') {
      return ensureState();
    }

    const fileName = state.updates.fileName || path.basename(new URL(state.updates.downloadUrl).pathname);
    const targetPath = path.join(app.getPath('userData'), 'updates', fileName);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    writeUpdateState({
      status: 'downloading',
      message: updateMessage('downloading'),
      downloadedPath: '',
      progress: 0,
    });

    try {
      const response = await fetch(state.updates.downloadUrl);
      if (!response.ok || !response.body) {
        throw new Error(`Download failed ${response.status}`);
      }

      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(targetPath));

      if (state.updates.sha256) {
        const digest = await sha256File(targetPath);
        if (digest !== state.updates.sha256) {
          fs.rmSync(targetPath, { force: true });
          throw new Error('Update checksum failed');
        }
      }

      if (Notification.isSupported()) {
        new Notification({
          title: 'Nubem Drive',
          body: autoInstall ? 'Installing update' : 'Update ready',
        }).show();
      }

      const readyState = writeUpdateState({
        status: 'ready',
        message: updateMessage('ready'),
        downloadedPath: targetPath,
        progress: 100,
      });

      if (autoInstall) {
        return installUpdate();
      }

      return readyState;
    } catch (error) {
      return writeUpdateState({
        status: 'error',
        message: error instanceof Error ? error.message : updateMessage('error'),
        progress: 0,
      });
    } finally {
      updateWork = null;
    }
  })();

  return updateWork;
};

const shellEscape = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

const waitForChild = (child) =>
  new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Installer exited ${code ?? 'unknown'}`));
    });
  });

const installUpdate = async () => {
  const state = ensureState();
  const updatePath = state.updates.downloadedPath;

  if (!updatePath || !fs.existsSync(updatePath)) {
    return downloadUpdate();
  }

  writeUpdateState({
    status: 'installing',
    message: updateMessage('installing'),
  });

  if (process.platform === 'win32') {
    const child = spawn(updatePath, ['/S'], { detached: true, stdio: 'ignore' });
    child.unref();
    app.quit();
    return ensureState();
  }

  if (process.platform === 'linux' && updatePath.endsWith('.deb')) {
    if (fs.existsSync('/usr/bin/pkexec')) {
      const child = spawn('/usr/bin/pkexec', ['/bin/sh', '-c', `/usr/bin/apt install -y ${shellEscape(updatePath)}`], {
        stdio: 'ignore',
      });

      try {
        await waitForChild(child);
      } catch (error) {
        return writeUpdateState({
          status: 'error',
          message: error instanceof Error ? error.message : updateMessage('error'),
        });
      }

      const nextState = writeUpdateState({
        status: 'current',
        latestVersion: state.updates.latestVersion || app.getVersion(),
        message: updateMessage('current'),
        progress: 100,
      });

      app.relaunch();
      app.quit();
      return nextState;
    }

    await shell.openPath(updatePath);
    return ensureState();
  }

  await shell.openPath(updatePath);
  return ensureState();
};

const scheduleUpdateChecks = () => {
  if (isDev) return;

  setTimeout(() => {
    checkForUpdates({ autoDownload: true, autoInstall: true }).catch(() => undefined);
  }, 8000);

  updateTimer = setInterval(() => {
    checkForUpdates({ autoDownload: true, autoInstall: true }).catch(() => undefined);
  }, 6 * 60 * 60 * 1000);
};

const resolveDirectoryPaths = (paths) =>
  paths
    .map((folderPath) => path.resolve(folderPath))
    .filter((folderPath) => {
      try {
        return fs.statSync(folderPath).isDirectory();
      } catch {
        return false;
      }
    });

const addFoldersFromPaths = (folderPaths, detail = 'Queued for storage') => {
  const state = ensureState();
  const knownPaths = new Set(state.folders.map((folder) => folder.path));
  const nextFolders = resolveDirectoryPaths(folderPaths)
    .filter((folderPath) => !knownPaths.has(folderPath))
    .map(makeFolder);

  if (nextFolders.length === 0) {
    return { state, added: [] };
  }

  const nextState = addActivity(
    { ...state, folders: [...nextFolders, ...state.folders] },
    'upload',
    nextFolders.length === 1 ? nextFolders[0].name : `${nextFolders.length} folders`,
    detail
  );

  return { state: writeState(nextState), added: nextFolders };
};

const addVaultsFromPaths = async (folderPaths, detail = 'Vault added') => {
  let result = addFoldersFromPaths(folderPaths, detail);
  let state = result.state;

  for (const folder of result.added) {
    try {
      state = await shareVault(folder.id, folder.relayUrl || defaultRelayUrl);
    } catch {
      state = ensureState();
    }
  }

  return { state, added: result.added };
};

const getFolderArgs = (argv = process.argv, prefix, marker) => {
  const prefixed = argv
    .filter((item) => typeof item === 'string' && item.startsWith(prefix))
    .map((item) => item.slice(prefix.length))
    .filter(Boolean);

  if (prefixed.length > 0) {
    return prefixed;
  }

  const markerIndex = argv.indexOf(marker);
  if (markerIndex === -1) {
    return [];
  }

  return argv.slice(markerIndex + 1).filter((item) => item && !item.startsWith('--'));
};

const getCloudFolderArgs = (argv = process.argv) => getFolderArgs(argv, 'nubem-cloud-folder:', '--cloud-folder');

const getRemoveCloudFolderArgs = (argv = process.argv) => getFolderArgs(argv, 'nubem-remove-folder:', '--remove-cloud-folder');

const notifyClouded = (added) => {
  if (!Notification.isSupported()) {
    return;
  }

  const body = added.length === 1 ? `${added[0].name} queued` : `${added.length} folders queued`;
  new Notification({ title: 'Nubem Drive', body }).show();
};

const notifyCloudUploadStarted = (folders) => {
  if (!Notification.isSupported()) {
    return;
  }

  const body = folders.length === 1 ? `Queuing ${folders[0].name}` : `Queuing ${folders.length} folders`;
  new Notification({ title: 'Nubem Drive', body }).show();
};

const notifyCloudRemoveStarted = (folders) => {
  if (!Notification.isSupported()) {
    return;
  }

  const body = folders.length === 1 ? `Removing ${folders[0].name}` : `Removing ${folders.length} folders`;
  new Notification({ title: 'Nubem Drive', body }).show();
};

const notifyCloudRemoved = (folders) => {
  if (!Notification.isSupported()) {
    return;
  }

  const body = folders.length === 1 ? `${folders[0].name} removed` : `${folders.length} folders removed`;
  new Notification({ title: 'Nubem Drive', body }).show();
};

const notifyCloudError = (message) => {
  if (!Notification.isSupported()) {
    return;
  }

  new Notification({ title: 'Nubem Drive', body: message }).show();
};

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1060,
    minHeight: 680,
    title: 'Nubem Drive',
    backgroundColor: '#f4f1ea',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

const focusMainWindow = () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
};

const cloudFoldersAndNotify = async (folderPaths) => {
  const state = ensureState();
  const clientVault = findDefaultClientVault(state);
  if (clientVault) {
    const folders = resolveDirectoryPaths(folderPaths).map((folderPath) => ({ name: path.basename(folderPath) || folderPath }));
    notifyCloudUploadStarted(folders);

    try {
      await cloudFoldersToDefaultVault(folderPaths);
      notifyClouded(folders);
    } catch (error) {
      notifyCloudError(error instanceof Error ? error.message : 'Upload failed');
    }
    return;
  }

  if (state.pairing.role === 'client') {
    focusMainWindow();
    notifyCloudError('Join a vault before clouding folders');
    return;
  }

  const { added } = await addVaultsFromPaths(folderPaths, 'Vault added from context menu');
  if (added.length > 0) {
    notifyClouded(added);
  }
};

const removeCloudFoldersAndNotify = async (folderPaths) => {
  const folders = resolveDirectoryPaths(folderPaths).map((folderPath) => ({ name: path.basename(folderPath) || folderPath }));
  if (folders.length === 0) {
    notifyCloudError('Select a folder to remove');
    return;
  }

  focusMainWindow();
  notifyCloudRemoveStarted(folders);

  try {
    await removeCloudFoldersFromDefaultVault(folderPaths);
    notifyCloudRemoved(folders);
  } catch (error) {
    notifyCloudError(error instanceof Error ? error.message : 'Could not remove from cloud');
  }
};

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const cloudFolderArgs = getCloudFolderArgs(argv);
    const removeCloudFolderArgs = getRemoveCloudFolderArgs(argv);

    app.whenReady().then(async () => {
      if (removeCloudFolderArgs.length > 0) {
        await removeCloudFoldersAndNotify(removeCloudFolderArgs);
        focusMainWindow();
        return;
      }

      if (cloudFolderArgs.length > 0) {
        await cloudFoldersAndNotify(cloudFolderArgs);
        focusMainWindow();
        return;
      }

      focusMainWindow();
    });
  });
}

app.whenReady().then(async () => {
  if (!singleInstanceLock) {
    return;
  }

  const startupCloudFolderArgs = getCloudFolderArgs();
  const startupRemoveCloudFolderArgs = getRemoveCloudFolderArgs();

  ipcMain.handle('app:get-state', () => {
    refreshPairingState().catch(() => undefined);
    return ensureState();
  });

  ipcMain.handle('folders:choose', async () => {
    const currentState = ensureState();
    const clientVault = findDefaultClientVault(currentState);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: clientVault || currentState.pairing.role === 'client' ? 'Add to cloud' : 'Add vault',
      properties: ['openDirectory', 'multiSelections', 'createDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return ensureState();
    }

    if (findDefaultClientVault(ensureState())) {
      return cloudFoldersToDefaultVault(result.filePaths);
    }

    if (ensureState().pairing.role === 'client') {
      notifyCloudError('Join a vault before clouding folders');
      return ensureState();
    }

    return (await addVaultsFromPaths(result.filePaths, 'Vault added')).state;
  });

  ipcMain.handle('folders:cloud', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add to cloud',
      properties: ['openDirectory', 'multiSelections', 'createDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return ensureState();
    }

    return cloudFoldersToDefaultVault(result.filePaths);
  });

  ipcMain.handle('folders:remove', async (_event, id) => {
    const state = ensureState();
    const folder = state.folders.find((item) => item.id === id);

    if (!folder) {
      return state;
    }

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Remove from cloud',
      message: `Remove "${folder.name}" from Nubem Drive?`,
      detail: 'Files stay on this computer. Paired devices will stop seeing this folder.',
    });

    if (result.response !== 0) {
      return ensureState();
    }

    const nextState = addActivity(
      {
        ...state,
        folders: state.folders.filter((item) => item.id !== id),
      },
      'remove',
      folder.name,
      'Removed from cloud'
    );

    return writeState(nextState);
  });

  ipcMain.handle('folders:set-mode', (_event, id, localMode) => {
    const state = ensureState();
    const folder = state.folders.find((item) => item.id === id);
    const nextState = addActivity(
      {
        ...state,
        folders: state.folders.map((item) => (item.id === id ? { ...item, localMode } : item)),
      },
      'pin',
      folder?.name || 'Folder',
      localMode === 'local' ? 'Kept locally' : localMode === 'online' ? 'Online only' : 'Mirrored to storage'
    );

    return writeState(nextState);
  });

  ipcMain.handle('folders:toggle-sync', (_event, id) => {
    const state = ensureState();
    const folder = state.folders.find((item) => item.id === id);
    const nextStatus = folder?.status === 'paused' ? 'queued' : 'paused';
    const nextState = addActivity(
      {
        ...state,
        folders: state.folders.map((item) => (item.id === id ? { ...item, status: nextStatus } : item)),
      },
      nextStatus === 'paused' ? 'pause' : 'upload',
      folder?.name || 'Folder',
      nextStatus === 'paused' ? 'Paused' : 'Queued'
    );

    return writeState(nextState);
  });

  ipcMain.handle('folders:reveal', (_event, folderPath) => {
    shell.showItemInFolder(folderPath);
  });

  ipcMain.handle('pairing:create-code', (_event, relayUrl) => createPairCode(relayUrl));
  ipcMain.handle('pairing:join', (_event, relayUrl, code) => joinPairing(relayUrl, code));
  ipcMain.handle('vaults:share', (_event, id, relayUrl) => shareVault(id, relayUrl));
  ipcMain.handle('pairing:refresh', () => refreshPairingState());
  ipcMain.handle('pairing:reset', () => resetPairing());
  ipcMain.handle('server:set-mode', (_event, enabled) => setServerMode(Boolean(enabled)));
  ipcMain.handle('remote:browse', (_event, folderId, relativePath) => browseRemoteFolder(folderId, relativePath));
  ipcMain.handle('remote:download', (_event, folderId, relativePath) => downloadRemoteFile(folderId, relativePath));
  ipcMain.handle('remote:delete', (_event, folderId, relativePath) => deleteRemoteEntry(folderId, relativePath));
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('updates:download', () => downloadUpdate());
  ipcMain.handle('updates:install', () => installUpdate());

  heartbeatTimer = setInterval(() => {
    refreshPairingState().catch(() => undefined);
  }, 5000);

  scheduleUpdateChecks();
  startSyncProcessor();
  createWindow();

  if (startupRemoveCloudFolderArgs.length > 0) {
    await removeCloudFoldersAndNotify(startupRemoveCloudFolderArgs);
    focusMainWindow();
  }

  if (startupCloudFolderArgs.length > 0) {
    await cloudFoldersAndNotify(startupCloudFolderArgs);
    focusMainWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  if (updateTimer) {
    clearInterval(updateTimer);
  }

  if (syncTimer) {
    clearInterval(syncTimer);
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
