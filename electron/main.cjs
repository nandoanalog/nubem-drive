const { app, BrowserWindow, Notification, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
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

const dataFile = () => path.join(app.getPath('userData'), 'state.json');
const defaultRelayUrl = 'https://drive.nubem.org';
const defaultUpdateManifestUrl = `${defaultRelayUrl}/latest.json`;

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
      capacityBytes: 2_000_000_000_000,
      usedBytes: 612_000_000_000,
      status: 'online',
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
      role: null,
      status: 'idle',
    },
    folders: [],
    activity: [],
    updates: updateDefaults(),
    devices: [
      { id: deviceId, name: os.hostname(), role: 'This PC', status: 'online', address: 'Local' },
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
    role: pairing.role === 'client' ? 'Client' : 'This PC',
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
      relayStatus: relayStatusFromPairing(pairing),
    },
    currentDevice,
    pairing,
    folders,
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
    const state = normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')), { restoreUpdates: true });
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
  role: device.role === 'storage' ? 'Storage node' : device.id === currentDeviceId ? 'This PC' : 'Client',
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
          role: null,
          status: 'idle',
        },
      },
      'link',
      'Link reset',
      'Ready'
    )
  );
};

const processingRelayRequests = new Set();

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

  const chunkSize = 768 * 1024;
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
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const stream = fs.createWriteStream(target);
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

  return {
    fileName: path.basename(target),
    relativePath: request.relativePath,
    totalBytes: fs.statSync(target).size,
    sizeLabel: formatBytes(fs.statSync(target).size),
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
    if (processingRelayRequests.has(request.id)) {
      continue;
    }

    processingRelayRequests.add(request.id);
    try {
      const result =
        request.type === 'download'
          ? await sendFileToRelay(request.id, vaultFolderId, request.relativePath)
          : request.type === 'upload'
            ? await receiveFileFromRelay(vaultFolderId, request)
            : listCloudFolder(ensureState(), vaultFolderId, request.relativePath);
      await completeRelayRequest(vaultFolderId, request.id, result);
    } catch (error) {
      await completeRelayRequest(vaultFolderId, request.id, null, error instanceof Error ? error.message : 'Request failed');
    } finally {
      processingRelayRequests.delete(request.id);
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
      files.push({ path: target, size: stat.size });
    }
  };

  visit(root);
  return files;
};

const createUploadRequest = async (vaultFolderId, relativePath, fileName, totalBytes, chunkCount) => {
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
  });

  return payload.requestId;
};

const uploadFileToVault = async (vaultFolderId, sourceFile, targetRelativePath) => {
  const stat = fs.statSync(sourceFile);
  const chunkSize = 768 * 1024;
  const chunkCount = Math.max(1, Math.ceil(stat.size / chunkSize));
  let requestId = '';
  let file;
  const buffer = Buffer.alloc(chunkSize);
  let index = 0;
  let offset = 0;

  try {
    file = fs.openSync(sourceFile, 'r');
    requestId = await createUploadRequest(vaultFolderId, targetRelativePath, path.basename(sourceFile), stat.size, chunkCount);

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

const uploadFolderToVault = async (vaultFolderId, folderPath) => {
  const root = path.resolve(folderPath);
  const rootName = path.basename(root) || 'Folder';
  const files = walkFiles(root);

  for (const file of files) {
    const relativePath = [rootName, relativeCloudPath(root, file.path)].filter(Boolean).join('/');
    await uploadFileToVault(vaultFolderId, file.path, relativePath);
  }

  return {
    name: rootName,
    fileCount: files.length,
  };
};

const cloudFoldersToDefaultVault = async (folderPaths) => {
  let state = ensureState();
  const vault = findDefaultClientVault(state);

  if (!vault) {
    focusMainWindow();
    throw new Error('Join a vault first');
  }

  const folders = resolveDirectoryPaths(folderPaths);
  for (const folderPath of folders) {
    const result = await uploadFolderToVault(vault.id, folderPath);
    state = writeState(addActivity(ensureState(), 'upload', result.name, `${result.fileCount} files to ${vault.name}`));
  }

  return state;
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

const getCloudFolderArgs = (argv = process.argv) => {
  const marker = argv.indexOf('--cloud-folder');
  if (marker === -1) {
    return [];
  }

  return argv.slice(marker + 1).filter((item) => item && !item.startsWith('--'));
};

const notifyClouded = (added) => {
  if (!Notification.isSupported()) {
    return;
  }

  const body = added.length === 1 ? `${added[0].name} clouded` : `${added.length} folders clouded`;
  new Notification({ title: 'Nubem Drive', body }).show();
};

const notifyCloudUploadStarted = (folders) => {
  if (!Notification.isSupported()) {
    return;
  }

  const body = folders.length === 1 ? `Uploading ${folders[0].name}` : `Uploading ${folders.length} folders`;
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

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const cloudFolderArgs = getCloudFolderArgs(argv);

    app.whenReady().then(async () => {
      if (cloudFolderArgs.length > 0) {
        await cloudFoldersAndNotify(cloudFolderArgs);
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

  const cloudFolderArgs = getCloudFolderArgs();
  if (cloudFolderArgs.length > 0) {
    await cloudFoldersAndNotify(cloudFolderArgs);
    setTimeout(() => app.quit(), 600);
    return;
  }

  ipcMain.handle('app:get-state', () => {
    refreshPairingState().catch(() => undefined);
    return ensureState();
  });

  ipcMain.handle('folders:choose', async () => {
    const currentState = ensureState();
    const clientVault = findDefaultClientVault(currentState);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: clientVault || currentState.pairing.role === 'client' ? 'Cloud folder' : 'Add vault',
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
      title: 'Cloud folder',
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
  ipcMain.handle('remote:browse', (_event, folderId, relativePath) => browseRemoteFolder(folderId, relativePath));
  ipcMain.handle('remote:download', (_event, folderId, relativePath) => downloadRemoteFile(folderId, relativePath));
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('updates:download', () => downloadUpdate());
  ipcMain.handle('updates:install', () => installUpdate());

  heartbeatTimer = setInterval(() => {
    refreshPairingState().catch(() => undefined);
  }, 5000);

  scheduleUpdateChecks();
  createWindow();

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

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
