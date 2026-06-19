#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const defaultRelayUrl = 'https://drive.nubem.org';
const pollIntervalMs = Number(process.env.NUBEM_STORAGE_POLL_MS || 5000);
const activePollIntervalMs = Number(process.env.NUBEM_STORAGE_ACTIVE_POLL_MS || 1000);
const immediatePollIntervalMs = Number(process.env.NUBEM_STORAGE_IMMEDIATE_POLL_MS || 250);
const chunkSize = 4 * 1024 * 1024;
const defaultRelayTimeoutMs = 20 * 1000;
const relayChunkReadTimeoutMs = 90 * 1000;
const relayChunkWriteTimeoutMs = 5 * 60 * 1000;
const relayResultTimeoutMs = 45 * 1000;
const relayRequestLockTtlMs = 10 * 60 * 1000;
const deleteRequestPrefix = '.nubem-command/delete/';
const processingRelayRequests = new Set();
const trafficSamples = new Map();
const relayFeatureCacheTtlMs = 60 * 1000;
const relayFeatureCache = new Map();
const dataFile = () =>
  process.env.NUBEM_DRIVE_STATE ||
  path.join(os.homedir(), process.platform === 'win32' ? 'AppData/Roaming/nubem-drive/state.json' : '.config/nubem-drive/state.json');
const storageTitle = () => (dataFile().includes('nubem-server') ? 'Nubem Server Storage node' : 'Nubem Drive Storage node');

const now = () => new Date().toISOString();

const writeJsonFileAtomic = (file, value) => {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
};

const backupUnreadableState = (file) => {
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}.bak`);
    }
  } catch {
    // Keep the storage node alive even if the backup cannot be written.
  }
};

const readJsonFile = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
};

const mergeExistingStorageFoldersOnEmptyWrite = (file, normalized) => {
  if (normalized.folders?.length) {
    return normalized;
  }

  const existing = readJsonFile(file);
  const existingFolders = Array.isArray(existing?.folders)
    ? existing.folders.filter((folder) => folder.vaultRole !== 'client')
    : [];

  if (!existingFolders.length) {
    return normalized;
  }

  const existingPairing = existing.pairing || {};
  const existingDevice = existing.currentDevice || {};
  const existingDevices = Array.isArray(existing.devices) ? existing.devices : [];

  return {
    ...normalized,
    currentDevice: existingDevice.id
      ? {
          ...normalized.currentDevice,
          id: existingDevice.id,
          name: existingDevice.name || normalized.currentDevice?.name,
          platform: existingDevice.platform || normalized.currentDevice?.platform,
        }
      : normalized.currentDevice,
    pairing: {
      ...normalized.pairing,
      pairId: normalized.pairing?.pairId || existingPairing.pairId,
      token: normalized.pairing?.token || existingPairing.token,
      status: existingPairing.status === 'linked' ? 'linked' : normalized.pairing?.status,
      storageName: normalized.pairing?.storageName || existingPairing.storageName,
      linkedAt: normalized.pairing?.linkedAt || existingPairing.linkedAt,
      lastSeenAt: normalized.pairing?.lastSeenAt || existingPairing.lastSeenAt,
    },
    folders: existingFolders,
    devices: existingDevices.length > (normalized.devices?.length || 0) ? existingDevices : normalized.devices,
  };
};

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

const emptyTraffic = () => ({
  updatedAt: now(),
  uploadBytesPerSecond: 0,
  downloadBytesPerSecond: 0,
  active: [],
});

const normalizeTraffic = (traffic = {}) => {
  const cutoff = Date.now() - 20 * 1000;
  const active = Array.isArray(traffic.active)
    ? traffic.active
        .filter((transfer) => new Date(transfer?.updatedAt || 0).getTime() >= cutoff)
        .map((transfer) => ({
          id: String(transfer.id || ''),
          direction: transfer.direction === 'download' ? 'download' : 'upload',
          vaultId: String(transfer.vaultId || ''),
          vaultName: String(transfer.vaultName || 'Vault'),
          clientName: String(transfer.clientName || 'Client'),
          fileName: String(transfer.fileName || 'File'),
          relativePath: String(transfer.relativePath || ''),
          totalBytes: Number.isFinite(transfer.totalBytes) ? Math.max(0, transfer.totalBytes) : 0,
          transferredBytes: Number.isFinite(transfer.transferredBytes) ? Math.max(0, transfer.transferredBytes) : 0,
          rateBytesPerSecond: Number.isFinite(transfer.rateBytesPerSecond) ? Math.max(0, transfer.rateBytesPerSecond) : 0,
          startedAt: String(transfer.startedAt || now()),
          updatedAt: String(transfer.updatedAt || now()),
        }))
        .filter((transfer) => transfer.id)
    : [];

  return {
    updatedAt: String(traffic.updatedAt || now()),
    uploadBytesPerSecond: active
      .filter((transfer) => transfer.direction === 'download')
      .reduce((sum, transfer) => sum + transfer.rateBytesPerSecond, 0),
    downloadBytesPerSecond: active
      .filter((transfer) => transfer.direction === 'upload')
      .reduce((sum, transfer) => sum + transfer.rateBytesPerSecond, 0),
    active,
  };
};

const mapRelayDevice = (device, currentDeviceId) => ({
  id: device.id,
  name: device.name || 'Device',
  role: device.role === 'storage' ? 'Server' : 'Client',
  status: device.status || 'offline',
  address: device.id === currentDeviceId ? 'This PC' : 'Relay',
});

const onlineClientNamesFromPayload = (payload, currentDeviceId) => {
  if (!Array.isArray(payload?.devices)) return null;

  return payload.devices
    .filter((device) => device.id !== currentDeviceId && device.role === 'client' && device.status === 'online')
    .map((device) => String(device.name || 'Client').trim())
    .filter(Boolean)
    .slice(0, 32);
};

const clientVaultsFromPayload = (payload) => {
  if (!Array.isArray(payload?.clientVaults)) return null;

  return payload.clientVaults
    .map((vault) => ({
      name: String(vault?.name || 'My Vault').trim() || 'My Vault',
      clientName: String(vault?.clientName || 'Client').trim() || 'Client',
      remotePathPrefix: String(vault?.remotePathPrefix || '').trim(),
      status: ['online', 'sleeping', 'offline'].includes(vault?.status) ? vault.status : 'offline',
      lastSeenAt: String(vault?.lastSeenAt || ''),
    }))
    .slice(0, 128);
};

const normalizeRemotePath = (relativePath = '') =>
  String(relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');

const requestVaultInfo = (folder, request) => {
  const relativePath = normalizeRemotePath(request.relativePath || '');
  const firstSegment = relativePath.split('/').filter(Boolean)[0] || '';
  const vaults = Array.isArray(folder.clientVaults) ? folder.clientVaults : [];
  const vault = vaults.find((item) => normalizeRemotePath(item.remotePathPrefix || '') === firstSegment);

  return {
    vaultId: vault?.remotePathPrefix || firstSegment || folder.id,
    vaultName: vault?.name || firstSegment || folder.name || 'Vault',
    clientName: vault?.clientName || firstSegment || 'Client',
  };
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
    traffic: emptyTraffic(),
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
    traffic: normalizeTraffic(state.traffic),
    activity: Array.isArray(state.activity) ? state.activity : [],
  };
};

const ensureState = () => {
  const file = dataFile();
  if (!fs.existsSync(file)) {
    writeJsonFileAtomic(file, makeInitialState());
  }

  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    backupUnreadableState(file);
    const fresh = makeInitialState();
    writeJsonFileAtomic(file, fresh);
    return fresh;
  }
};

const writeState = (state) => {
  const file = dataFile();
  const normalized = mergeExistingStorageFoldersOnEmptyWrite(file, normalizeState(state));
  writeJsonFileAtomic(file, normalized);
  return normalized;
};

const addActivity = (state, type, label, detail) => ({
  ...state,
  activity: [
    { id: crypto.randomUUID(), type, label, detail, at: now() },
    ...(Array.isArray(state.activity) ? state.activity : []),
  ].slice(0, 16),
});

const writeTraffic = (activeTransfers) => {
  const state = ensureState();
  const active = activeTransfers.filter((transfer) => transfer.transferredBytes < transfer.totalBytes || transfer.rateBytesPerSecond > 0);
  return writeState({
    ...state,
    traffic: normalizeTraffic({
      updatedAt: now(),
      active,
    }),
  });
};

const reportTransfer = (folder, request, direction, totalBytes, transferredBytes, force = false) => {
  const currentTime = Date.now();
  const sample = trafficSamples.get(request.id) || {
    bytes: transferredBytes,
    at: currentTime,
    rate: 0,
    writtenAt: 0,
    startedAt: now(),
  };
  const elapsedMs = Math.max(1, currentTime - sample.at);
  const deltaBytes = Math.max(0, transferredBytes - sample.bytes);
  const rate = deltaBytes > 0 ? (deltaBytes * 1000) / elapsedMs : sample.rate;

  if (!force && currentTime - sample.writtenAt < 900) {
    trafficSamples.set(request.id, {
      ...sample,
      bytes: transferredBytes,
      at: currentTime,
      rate,
    });
    return;
  }

  const vault = requestVaultInfo(folder, request);
  const state = ensureState();
  const currentTraffic = normalizeTraffic(state.traffic);
  const transfer = {
    id: request.id,
    direction,
    ...vault,
    fileName: path.basename(request.relativePath || request.fileName || 'File'),
    relativePath: normalizeRemotePath(request.relativePath || ''),
    totalBytes: Math.max(0, Number(totalBytes || 0)),
    transferredBytes: Math.max(0, Number(transferredBytes || 0)),
    rateBytesPerSecond: rate,
    startedAt: sample.startedAt,
    updatedAt: now(),
  };

  trafficSamples.set(request.id, {
    bytes: transferredBytes,
    at: currentTime,
    rate,
    writtenAt: currentTime,
    startedAt: sample.startedAt,
  });
  writeTraffic([
    ...currentTraffic.active.filter((item) => item.id !== request.id),
    transfer,
  ]);
};

const clearTransfer = (requestId) => {
  trafficSamples.delete(requestId);
  const state = ensureState();
  const traffic = normalizeTraffic(state.traffic);
  writeTraffic(traffic.active.filter((transfer) => transfer.id !== requestId));
};

const localRelayDevice = (state) => ({
  id: state.currentDevice.id,
  name: state.currentDevice.name,
  platform: state.currentDevice.platform,
  role: 'storage',
});

const relayRequestTimeout = (endpoint, body = {}) => {
  if (endpoint === '/api/drive/requests/chunk') {
    return Object.prototype.hasOwnProperty.call(body || {}, 'data')
      ? relayChunkWriteTimeoutMs
      : relayChunkReadTimeoutMs;
  }

  if (endpoint === '/api/drive/requests/result') {
    return relayResultTimeoutMs;
  }

  return defaultRelayTimeoutMs;
};

const relayRequest = async (relayUrl, endpoint, body, timeoutMs = relayRequestTimeout(endpoint, body)) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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

const relayFeatures = async (relayUrl) => {
  const normalizedRelayUrl = normalizeRelayUrl(relayUrl);
  const cached = relayFeatureCache.get(normalizedRelayUrl);
  if (cached && Date.now() - cached.checkedAt < relayFeatureCacheTtlMs) return cached.features;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${normalizedRelayUrl}/api/drive/health`, { signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    const features = response.ok && Array.isArray(payload.features) ? payload.features.map(String) : [];
    relayFeatureCache.set(normalizedRelayUrl, { features, checkedAt: Date.now() });
    return features;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
};

const relaySupportsBinaryChunks = async (relayUrl) => {
  const features = await relayFeatures(relayUrl);
  return features.includes('binaryChunks');
};

const summarizeLocalFolder = (folder) => {
  let itemCount = 0;
  let totalBytes = 0;
  let latestModifiedAt = folder.updatedAt || now();
  const stack = [folder.path];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(current, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }

        if (stat.isFile()) {
          itemCount += 1;
          totalBytes += stat.size;
          if (stat.mtime.getTime() > new Date(latestModifiedAt || 0).getTime()) {
            latestModifiedAt = stat.mtime.toISOString();
          }
        }
      } catch {
        // Ignore files that disappear while the folder is being summarized.
      }
    }
  }

  return {
    itemCount,
    sizeBytes: totalBytes,
    sizeLabel: formatBytes(totalBytes),
    updatedAt: latestModifiedAt,
  };
};

const publicVaultFolder = (state, folder) => {
  const summary = summarizeLocalFolder(folder);
  return {
    id: folder.id,
    name: folder.name,
    path: folder.name,
    sizeBytes: summary.sizeBytes,
    sizeLabel: summary.sizeLabel,
    itemCount: summary.itemCount,
    updatedAt: summary.updatedAt,
    status: folder.status === 'paused' ? 'paused' : 'synced',
    localMode: 'online',
    devices: [state.currentDevice.name],
    progress: 100,
  };
};

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
    devices: Array.isArray(payload.devices)
      ? payload.devices.map((device) => mapRelayDevice(device, state.currentDevice.id))
      : state.devices,
    folders: state.folders.map((folder) => {
      if (folder.id !== folderId) return folder;
      const remoteFolder = Array.isArray(payload.folders) ? payload.folders[0] : null;
      const connectedClients = onlineClientNamesFromPayload(payload, state.currentDevice.id);
      const clientVaults = clientVaultsFromPayload(payload);

      return {
        ...folder,
        vaultRole: 'storage',
        relayUrl: normalizeRelayUrl(folder.relayUrl || state.pairing.relayUrl || defaultRelayUrl),
        pairId: payload.pairId || folder.pairId,
        token: payload.token || folder.token,
        code: payload.code || folder.code,
        codeExpiresAt: payload.expiresAt || folder.codeExpiresAt,
        storageName: payload.storageName || folder.storageName,
        sizeBytes: Number.isFinite(remoteFolder?.sizeBytes) ? remoteFolder.sizeBytes : folder.sizeBytes,
        sizeLabel: remoteFolder?.sizeLabel || folder.sizeLabel,
        itemCount: Number.isFinite(remoteFolder?.itemCount) ? remoteFolder.itemCount : folder.itemCount,
        status: folder.status === 'paused' ? 'paused' : remoteFolder?.status || 'synced',
        localMode: folder.localMode || 'mirror',
        devices: connectedClients || folder.devices || [],
        clientVaults: clientVaults || folder.clientVaults || [],
        progress: Number.isFinite(remoteFolder?.progress) ? remoteFolder.progress : 100,
        updatedAt: remoteFolder?.updatedAt || now(),
      };
    }),
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

  return writeState(addActivity(nextState, 'vault', folder.name, 'Storage ready'));
};

const validateRelativePath = (relativePath = '') => {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);

  if (path.isAbsolute(normalized) || parts.some((part) => part === '..') || normalized.includes('\0')) {
    throw new Error('Invalid path');
  }

  return parts.join(path.sep);
};

const normalizeCloudRelativePath = (relativePath = '') =>
  validateRelativePath(relativePath).split(path.sep).filter(Boolean).join('/');

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

const clientVaultPrefixes = (folder) =>
  new Set((Array.isArray(folder.clientVaults) ? folder.clientVaults : [])
    .map((vault) => normalizeCloudRelativePath(vault.remotePathPrefix || ''))
    .filter(Boolean));

const ensureKnownClientVaultRoot = (folder, root, target, relativePath = '') => {
  const safeRelativePath = normalizeCloudRelativePath(relativePath);
  if (!safeRelativePath || !clientVaultPrefixes(folder).has(safeRelativePath)) {
    return false;
  }

  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Path outside folder');
  }

  fs.mkdirSync(target, { recursive: true });
  return true;
};

const statCloudTarget = (folder, root, target, relativePath = '') => {
  try {
    return fs.statSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT' && ensureKnownClientVaultRoot(folder, root, target, relativePath)) {
      return fs.statSync(target);
    }

    throw error;
  }
};

const listCloudFolder = (state, folderId, relativePath = '') => {
  const { folder, root, target } = resolveCloudPath(state, folderId, relativePath);
  const stat = statCloudTarget(folder, root, target, relativePath);

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
  const { folder, root, target } = resolveCloudPath(state, folderId, relativePath);
  const stat = statCloudTarget(folder, root, target, relativePath);
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

const uploadRelayBinaryChunk = async (folder, requestId, index, data) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), relayChunkWriteTimeoutMs);

  try {
    const response = await fetch(`${normalizeRelayUrl(folder.relayUrl || defaultRelayUrl)}/api/drive/requests/chunk-binary`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-nubem-pair-id': folder.pairId,
        'x-nubem-token': folder.token,
        'x-nubem-request-id': requestId,
        'x-nubem-chunk-index': String(index),
        'x-nubem-chunk-mode': 'write',
      },
      body: data,
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

const downloadRelayChunk = async (folder, requestId, index) =>
  relayRequest(folder.relayUrl || defaultRelayUrl, '/api/drive/requests/chunk', {
    pairId: folder.pairId,
    token: folder.token,
    requestId,
    index,
  });

const downloadRelayBinaryChunk = async (folder, requestId, index) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), relayChunkReadTimeoutMs);

  try {
    const response = await fetch(`${normalizeRelayUrl(folder.relayUrl || defaultRelayUrl)}/api/drive/requests/chunk-binary`, {
      method: 'POST',
      headers: {
        'x-nubem-pair-id': folder.pairId,
        'x-nubem-token': folder.token,
        'x-nubem-request-id': requestId,
        'x-nubem-chunk-index': String(index),
        'x-nubem-chunk-mode': 'read',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Relay ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Relay timeout');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const downloadRelayChunkBuffer = async (folder, requestId, index) => {
  if (await relaySupportsBinaryChunks(folder.relayUrl || defaultRelayUrl)) {
    return downloadRelayBinaryChunk(folder, requestId, index);
  }

  const chunk = await downloadRelayChunk(folder, requestId, index);
  return Buffer.from(chunk.data, 'base64');
};

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

const relayWorkHasStorageWork = (work) =>
  Boolean(work && (work.hasStorageWork || Number(work.waitingForStorage || 0) > 0));

const relayWorkHasFileWork = (work) =>
  Boolean(
    work &&
      (work.hasFileWork ||
        Number(work.clientUploading || 0) > 0 ||
        Number(work.waitingForStorage || 0) > 0 ||
        Number(work.serverReady || 0) > 0)
  );

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
  const useBinaryChunks = await relaySupportsBinaryChunks(folder.relayUrl || defaultRelayUrl);

  try {
    reportTransfer(folder, request, 'download', stat.size, 0, true);
    while (offset < stat.size) {
      const bytesRead = fs.readSync(file, buffer, 0, Math.min(chunkSize, stat.size - offset), offset);
      if (bytesRead <= 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (useBinaryChunks) {
        await uploadRelayBinaryChunk(folder, request.id, index, chunk);
      } else {
        await uploadRelayChunk(folder, request.id, index, chunk.toString('base64'));
      }
      offset += bytesRead;
      index += 1;
      reportTransfer(folder, request, 'download', stat.size, offset);
    }
  } finally {
    fs.closeSync(file);
    clearTransfer(request.id);
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
  let completed = false;
  let receiveError = null;
  let offset = 0;

  try {
    reportTransfer(folder, request, 'upload', Number(request.totalBytes || 0), 0, true);
    for (let index = 0; index < Number(request.chunkCount || 0); index += 1) {
      const chunk = await downloadRelayChunkBuffer(folder, request.id, index);
      stream.write(chunk);
      offset += chunk.length;
      reportTransfer(folder, request, 'upload', Number(request.totalBytes || 0), offset);
    }
    completed = true;
  } catch (error) {
    receiveError = error;
    throw error;
  } finally {
    try {
      await new Promise((resolve, reject) => {
        stream.end((error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      if (!receiveError) {
        throw error;
      }
    }

    if (!completed) {
      fs.rmSync(tmpTarget, { force: true });
    }
    clearTransfer(request.id);
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

  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        name: path.basename(target),
        relativePath: safeRelativePath.split(path.sep).join('/'),
        type: 'folder',
        deletedAt: now(),
        missing: true,
      };
    }

    throw error;
  }

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
    return { handled: 0, more: false, work: null };
  }

  let handled = 0;
  let more = false;
  let work = null;

  for (let batch = 0; batch < 8; batch += 1) {
    const payload = await relayRequest(currentFolder.relayUrl || defaultRelayUrl, '/api/drive/requests/poll', {
      pairId: currentFolder.pairId,
      token: currentFolder.token,
    });
    const requests = Array.isArray(payload.requests) ? payload.requests : [];
    work = payload.work || work;
    more = Boolean(payload.more);

    if (requests.length === 0) {
      break;
    }

    let processed = 0;
    for (const request of requests) {
      if (!acquireRelayRequestLock(request.id)) {
        continue;
      }

      processed += 1;
      try {
        const deleteRelativePath = decodeDeleteRequestPath(request);
        let result;
        if (deleteRelativePath) {
          result = deleteCloudPath(ensureState(), currentFolder.id, deleteRelativePath);
        } else if (request.type === 'download') {
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

    handled += processed;
    if (!more || processed === 0) {
      break;
    }
  }

  return { handled, more, work };
};

const tick = async () => {
  let state = ensureState();
  const folders = state.folders.filter((folder) => folder.vaultRole !== 'client' && folder.status !== 'paused');
  let nextDelayMs = pollIntervalMs;

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
      if (relayWorkHasFileWork(payload.work)) {
        nextDelayMs = Math.min(nextDelayMs, activePollIntervalMs);
      }

      if (!payload.work || relayWorkHasStorageWork(payload.work)) {
        const result = await handlePendingRelayRequests(current);
        if (result.handled > 0 || result.more || relayWorkHasStorageWork(result.work)) {
          nextDelayMs = Math.min(nextDelayMs, immediatePollIntervalMs);
        } else if (relayWorkHasFileWork(result.work)) {
          nextDelayMs = Math.min(nextDelayMs, activePollIntervalMs);
        }
      }
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

  return nextDelayMs;
};

const main = async () => {
  console.log(storageTitle());
  console.log(`state=${dataFile()}`);
  console.log(`poll=${pollIntervalMs}ms active=${activePollIntervalMs}ms immediate=${immediatePollIntervalMs}ms`);

  const schedule = (delayMs) => {
    setTimeout(async () => {
      try {
        const nextDelayMs = await tick();
        schedule(nextDelayMs);
      } catch (error) {
        console.error(`[${now()}] ${error instanceof Error ? error.message : 'Storage error'}`);
        schedule(pollIntervalMs);
      }
    }, Math.max(100, delayMs));
  };

  schedule(await tick());
};

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
