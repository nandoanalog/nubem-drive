#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const defaultRelayUrl = 'https://drive.nubem.org';
const pollIntervalMs = Number(process.env.NUBEM_STORAGE_POLL_MS || 5000);
const chunkSize = 256 * 1024;
const relayRequestLockTtlMs = 10 * 60 * 1000;
const processingRelayRequests = new Set();
const dataFile = () =>
  process.env.NUBEM_DRIVE_STATE ||
  path.join(os.homedir(), process.platform === 'win32' ? 'AppData/Roaming/nubem-drive/state.json' : '.config/nubem-drive/state.json');

const now = () => new Date().toISOString();

const normalizeRelayUrl = (value) => {
  const trimmed = String(value || '').trim() || defaultRelayUrl;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, '');
};

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

const makeInitialState = () => {
  const deviceId = crypto.randomUUID();
  return {
    currentDevice: {
      id: deviceId,
      name: os.hostname(),
      platform: process.platform,
      status: 'online',
    },
    pairing: {
      relayUrl: defaultRelayUrl,
      role: 'storage',
      status: 'idle',
    },
    folders: [],
    devices: [{ id: deviceId, name: os.hostname(), role: 'Storage node', status: 'online', address: 'Relay' }],
    activity: [],
  };
};

const normalizeState = (rawState) => {
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
    role: 'storage',
  };
  pairing.relayUrl = normalizeRelayUrl(pairing.relayUrl);

  const folders = Array.isArray(state.folders)
    ? state.folders.map((folder) => ({
        ...folder,
        vaultRole: folder.vaultRole || 'storage',
        relayUrl: normalizeRelayUrl(folder.relayUrl || pairing.relayUrl || defaultRelayUrl),
      }))
    : [];

  return {
    ...fresh,
    ...state,
    currentDevice,
    pairing,
    folders,
    activity: Array.isArray(state.activity) ? state.activity : [],
  };
};

const ensureState = () => {
  const file = dataFile();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(makeInitialState(), null, 2));
  }

  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    const fresh = makeInitialState();
    fs.writeFileSync(file, JSON.stringify(fresh, null, 2));
    return fresh;
  }
};

const writeState = (state) => {
  const normalized = normalizeState(state);
  const file = dataFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2));
  fs.renameSync(tmp, file);
  return normalized;
};

const addActivity = (state, type, label, detail) => ({
  ...state,
  activity: [
    { id: crypto.randomUUID(), type, label, detail, at: now() },
    ...(Array.isArray(state.activity) ? state.activity : []),
  ].slice(0, 16),
});

const localRelayDevice = (state) => ({
  id: state.currentDevice.id,
  name: state.currentDevice.name,
  platform: state.currentDevice.platform,
  role: 'storage',
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

const applyVaultPayloadToFolder = (state, folderId, payload) =>
  writeState({
    ...state,
    pairing: {
      ...state.pairing,
      role: 'storage',
      status: 'linked',
      relayUrl: normalizeRelayUrl(state.pairing.relayUrl || defaultRelayUrl),
      storageName: state.currentDevice.name,
      message: '',
      lastSeenAt: now(),
    },
    folders: state.folders.map((folder) =>
      folder.id === folderId
        ? {
            ...folder,
            vaultRole: 'storage',
            relayUrl: normalizeRelayUrl(folder.relayUrl || state.pairing.relayUrl || defaultRelayUrl),
            pairId: payload.pairId || folder.pairId,
            token: payload.token || folder.token,
            code: payload.code || folder.code,
            codeExpiresAt: payload.expiresAt || folder.codeExpiresAt,
            storageName: payload.storageName || folder.storageName,
            status: folder.status === 'paused' ? 'paused' : 'synced',
            progress: 100,
            updatedAt: now(),
          }
        : folder
    ),
  });

const shareVault = async (state, folder) => {
  const relayUrl = normalizeRelayUrl(folder.relayUrl || state.pairing.relayUrl || defaultRelayUrl);
  const payload = await relayRequest(relayUrl, '/api/drive/vaults/create', {
    device: localRelayDevice(state),
    folder: publicVaultFolder(state, folder),
  });

  const nextState = applyVaultPayloadToFolder(
    {
      ...state,
      folders: state.folders.map((item) =>
        item.id === folder.id ? { ...item, relayUrl, vaultRole: 'storage' } : item
      ),
    },
    folder.id,
    payload
  );

  return writeState(addActivity(nextState, 'vault', folder.name, payload.code || 'Shared'));
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
  if (!folder || folder.vaultRole === 'client') {
    throw new Error('Storage folder not found');
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
  return {
    folderId,
    path: currentPath,
    parentPath: currentPath ? currentPath.split('/').slice(0, -1).join('/') : '',
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

const uploadRelayChunk = async (folder, requestId, index, data) =>
  relayRequest(folder.relayUrl || defaultRelayUrl, '/api/drive/requests/chunk', {
    pairId: folder.pairId,
    token: folder.token,
    requestId,
    index,
    data,
  });

const downloadRelayChunk = async (folder, requestId, index) =>
  relayRequest(folder.relayUrl || defaultRelayUrl, '/api/drive/requests/chunk', {
    pairId: folder.pairId,
    token: folder.token,
    requestId,
    index,
  });

const completeRelayRequest = async (folder, requestId, result, error) =>
  relayRequest(folder.relayUrl || defaultRelayUrl, '/api/drive/requests/complete', {
    pairId: folder.pairId,
    token: folder.token,
    requestId,
    result,
    error,
  });

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

const sendFileToRelay = async (state, folder, request) => {
  const { target } = resolveCloudPath(state, folder.id, request.relativePath);
  const stat = fs.statSync(target);

  if (!stat.isFile()) {
    throw new Error('Not a file');
  }

  const file = fs.openSync(target, 'r');
  const buffer = Buffer.alloc(chunkSize);
  let index = 0;
  let offset = 0;

  try {
    while (offset < stat.size) {
      const bytesRead = fs.readSync(file, buffer, 0, Math.min(chunkSize, stat.size - offset), offset);
      if (bytesRead <= 0) break;
      await uploadRelayChunk(folder, request.id, index, buffer.subarray(0, bytesRead).toString('base64'));
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

const receiveFileFromRelay = async (state, folder, request) => {
  const { target } = resolveCloudPath(state, folder.id, request.relativePath);
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
      const chunk = await downloadRelayChunk(folder, request.id, index);
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

const handlePendingRelayRequests = async (folder) => {
  const state = ensureState();
  const currentFolder = state.folders.find((item) => item.id === folder.id);
  if (!currentFolder || currentFolder.vaultRole === 'client' || !currentFolder.pairId || !currentFolder.token) {
    return;
  }

  const payload = await relayRequest(currentFolder.relayUrl || defaultRelayUrl, '/api/drive/requests/poll', {
    pairId: currentFolder.pairId,
    token: currentFolder.token,
  });

  for (const request of payload.requests || []) {
    if (!acquireRelayRequestLock(request.id)) {
      continue;
    }

    try {
      let result;
      if (request.type === 'download') {
        result = await sendFileToRelay(state, currentFolder, request);
      } else if (request.type === 'upload') {
        result = await receiveFileFromRelay(state, currentFolder, request);
      } else if (request.type === 'delete') {
        result = deleteCloudPath(state, currentFolder.id, request.relativePath);
      } else if (request.type === 'stat') {
        result = statCloudPath(state, currentFolder.id, request.relativePath);
      } else {
        result = listCloudFolder(state, currentFolder.id, request.relativePath);
      }

      await completeRelayRequest(currentFolder, request.id, result);
    } catch (error) {
      await completeRelayRequest(currentFolder, request.id, null, error instanceof Error ? error.message : 'Request failed');
    } finally {
      releaseRelayRequestLock(request.id);
    }
  }
};

const tick = async () => {
  let state = ensureState();
  const folders = state.folders.filter((folder) => folder.vaultRole !== 'client' && folder.status !== 'paused');

  for (const folder of folders) {
    try {
      if (!folder.pairId || !folder.token) {
        state = await shareVault(state, folder);
      }

      const current = ensureState().folders.find((item) => item.id === folder.id) || folder;
      const payload = await relayRequest(current.relayUrl || defaultRelayUrl, '/api/drive/heartbeat', {
        pairId: current.pairId,
        token: current.token,
        device: localRelayDevice(ensureState()),
        folders: [publicVaultFolder(ensureState(), current)],
      });

      state = applyVaultPayloadToFolder(ensureState(), current.id, payload);
      await handlePendingRelayRequests(current);
    } catch (error) {
      state = ensureState();
      writeState({
        ...state,
        folders: state.folders.map((item) =>
          item.id === folder.id ? { ...item, status: 'offline', updatedAt: now() } : item
        ),
      });
      console.error(`[${now()}] ${folder.name}: ${error instanceof Error ? error.message : 'Storage error'}`);
    }
  }
};

const main = async () => {
  console.log(`Nubem Drive Storage node`);
  console.log(`state=${dataFile()}`);
  console.log(`poll=${pollIntervalMs}ms`);

  await tick();
  setInterval(() => {
    tick().catch((error) => console.error(`[${now()}] ${error instanceof Error ? error.message : 'Storage error'}`));
  }, pollIntervalMs);
};

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
