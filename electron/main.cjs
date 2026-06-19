const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, shell } = require('electron');

let packageMetadata = {};
try {
  packageMetadata = require('../package.json');
} catch {
  packageMetadata = {};
}

const detectAppFlavor = () => {
  const explicit = String(process.env.NUBEM_APP_FLAVOR || packageMetadata.nubemFlavor || '').toLowerCase();
  if (explicit === 'server') return 'server';
  if (explicit === 'client') return 'client';

  const identity = [packageMetadata.name, packageMetadata.productName, process.execPath].join(' ').toLowerCase();
  return identity.includes('server') ? 'server' : 'client';
};

const appFlavor = detectAppFlavor();
const isServerApp = appFlavor === 'server';
const appProductName = isServerApp ? 'Nubem Server' : 'Nubem Drive';
const appUserDataName = isServerApp ? 'nubem-server' : 'nubem-drive';
const appUserModelId = isServerApp ? 'org.nubem.server' : 'org.nubem.drive';

app.setName(appProductName);
if (process.platform === 'win32') {
  app.setAppUserModelId(appUserModelId);
}
app.setPath('userData', path.join(app.getPath('appData'), appUserDataName));

const isDev = !app.isPackaged;
let mainWindow;
let heartbeatTimer;
let updateTimer;
let updateWork;
let pairingRefreshWork;
let syncTimer;
let syncWork;
let syncWorkStartedAt = 0;
let commandTimer;
let commandWork;
let storageServiceStatusCache = { checkedAt: 0, value: 'offline' };
const storageServiceName = isServerApp ? 'nubem-server-storage.service' : 'nubem-drive-storage.service';

const dataFile = () => path.join(app.getPath('userData'), 'state.json');
const legacyDriveDataFile = () => path.join(app.getPath('appData'), 'nubem-drive', 'state.json');
const syncQueueRoot = () => path.join(app.getPath('userData'), 'sync-queues');
const syncQueueFile = (jobId) => path.join(syncQueueRoot(), `${jobId}.jsonl`);
const syncScanDirFile = (jobId, folderPath) =>
  path.join(syncQueueRoot(), `${jobId}.${crypto.createHash('sha1').update(folderPath).digest('hex')}.entries.jsonl`);
const defaultRelayUrl = 'https://drive.nubem.org';
const defaultUpdateManifestUrl = `${defaultRelayUrl}/latest.json`;
const relayChunkSize = 4 * 1024 * 1024;
const defaultRelayTimeoutMs = 20 * 1000;
const relayChunkReadTimeoutMs = 90 * 1000;
const relayChunkWriteTimeoutMs = 5 * 60 * 1000;
const relayResultTimeoutMs = 45 * 1000;
const minStorageReceiveWaitMs = 15 * 60 * 1000;
const storageReceiveWaitPerGbMs = 30 * 60 * 1000;
const maxStorageReceiveWaitMs = 6 * 60 * 60 * 1000;
const syncScanEntriesPerBatch = 500;
const syncScanFilesPerBatch = 500;
const syncUploadConcurrency = Math.max(
  1,
  Math.min(8, Number.parseInt(process.env.NUBEM_SYNC_CONCURRENCY || '4', 10) || 4)
);
const relayFeatureCacheTtlMs = 60 * 1000;
const relayFeatureCache = new Map();

const now = () => new Date().toISOString();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const writeJsonFileAtomic = (file, value) => {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }

    try {
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    } catch {
      fs.copyFileSync(tmp, file);
      fs.rmSync(tmp, { force: true });
    }
  }
};

const backupUnreadableState = (file) => {
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}.bak`);
    }
  } catch {
    // Keep startup alive even if the backup cannot be written.
  }
};

const readJsonFile = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
};

const mergeExistingServerVaultsOnEmptyWrite = (file, normalized) => {
  if (!isServerApp || normalized.folders?.length) {
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
  const existingStorageNode = existing.storageNode || {};
  const existingDevice = existing.currentDevice || {};
  const existingDevices = Array.isArray(existing.devices) ? existing.devices : [];

  return {
    ...normalized,
    storageNode: {
      ...normalized.storageNode,
      name: existingStorageNode.name || normalized.storageNode?.name,
      path: existingStorageNode.path || normalized.storageNode?.path,
    },
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

const appIconPath = () => {
  const extension = process.platform === 'win32' ? 'ico' : 'png';
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, `icon.${extension}`)]
    : [path.join(__dirname, '..', 'build', `icon.${extension}`)];
  return candidates.find((candidate) => fs.existsSync(candidate));
};

const updatePlatformKey = () => {
  const suffix = isServerApp ? '-server' : '';
  if (process.platform === 'win32') return `win32-x64${suffix}`;
  if (process.platform === 'linux') return `linux-x64${suffix}`;
  return `${process.platform}-${process.arch}${suffix}`;
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

const emptyVpsStats = () => ({
  updatedAt: now(),
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
});

const normalizeVpsStats = (stats = {}) => {
  const fresh = emptyVpsStats();
  const traffic = stats.traffic || {};
  const queue = stats.queue || {};
  const storage = stats.storage || {};
  const queueItems = Array.isArray(queue.items)
    ? queue.items
        .slice(0, 12)
        .map((item) => ({
          id: String(item?.id || ''),
          type: item?.type === 'download' ? 'download' : 'upload',
          status: ['uploading', 'pending', 'ready'].includes(item?.status) ? item.status : 'pending',
          stage: ['client-to-vps', 'waiting-server', 'server-to-vps', 'vps-to-server', 'waiting-client', 'vps-to-client', 'ready'].includes(item?.stage)
            ? item.stage
            : 'waiting-server',
          stageLabel: String(item?.stageLabel || ''),
          vaultName: String(item?.vaultName || 'Vault').slice(0, 120),
          clientName: String(item?.clientName || 'Client').slice(0, 120),
          fileName: String(item?.fileName || 'File').slice(0, 260),
          relativePath: String(item?.relativePath || '').slice(0, 2000),
          bytes: Number.isFinite(item?.bytes) ? Math.max(0, item.bytes) : 0,
          transferredBytes: Number.isFinite(item?.transferredBytes) ? Math.max(0, item.transferredBytes) : 0,
          totalBytes: Number.isFinite(item?.totalBytes) ? Math.max(0, item.totalBytes) : 0,
          createdAt: String(item?.createdAt || ''),
          updatedAt: String(item?.updatedAt || item?.createdAt || ''),
        }))
        .filter((item) => item.id)
    : [];
  const totalBytes = Number.isFinite(storage.totalBytes) ? Math.max(0, storage.totalBytes) : fresh.storage.totalBytes;
  const usedBytes = Number.isFinite(storage.usedBytes) ? Math.max(0, storage.usedBytes) : fresh.storage.usedBytes;
  const freeBytes = Number.isFinite(storage.freeBytes) ? Math.max(0, storage.freeBytes) : fresh.storage.freeBytes;
  const usedPercent = Number.isFinite(storage.usedPercent)
    ? Math.max(0, Math.min(100, storage.usedPercent))
    : totalBytes > 0
      ? Math.round((usedBytes / totalBytes) * 100)
      : 0;
  const stages = queue.stages && typeof queue.stages === 'object' ? queue.stages : {};
  const queueFiles = Number.isFinite(queue.files) ? Math.max(0, queue.files) : 0;
  const queueBytes = Number.isFinite(queue.bytes) ? Math.max(0, queue.bytes) : 0;
  const doneFiles = Number.isFinite(queue.doneFiles) ? Math.max(0, queue.doneFiles) : 0;
  const doneBytes = Number.isFinite(queue.doneBytes) ? Math.max(0, queue.doneBytes) : 0;

  return {
    updatedAt: String(stats.updatedAt || fresh.updatedAt),
    traffic: {
      inboundBytesPerSecond: Number.isFinite(traffic.inboundBytesPerSecond)
        ? Math.max(0, traffic.inboundBytesPerSecond)
        : 0,
      outboundBytesPerSecond: Number.isFinite(traffic.outboundBytesPerSecond)
        ? Math.max(0, traffic.outboundBytesPerSecond)
        : 0,
    },
    queue: {
      files: queueFiles,
      bytes: queueBytes,
      doneFiles,
      doneBytes,
      totalFiles: Number.isFinite(queue.totalFiles) ? Math.max(0, queue.totalFiles) : queueFiles + doneFiles,
      totalBytes: Number.isFinite(queue.totalBytes) ? Math.max(0, queue.totalBytes) : queueBytes + doneBytes,
      oldestAt: String(queue.oldestAt || ''),
      stages: {
        clientToVps: Number.isFinite(stages.clientToVps) ? Math.max(0, stages.clientToVps) : 0,
        waitingServer: Number.isFinite(stages.waitingServer) ? Math.max(0, stages.waitingServer) : 0,
        serverToVps: Number.isFinite(stages.serverToVps) ? Math.max(0, stages.serverToVps) : 0,
        vpsToServer: Number.isFinite(stages.vpsToServer) ? Math.max(0, stages.vpsToServer) : 0,
        waitingClient: Number.isFinite(stages.waitingClient) ? Math.max(0, stages.waitingClient) : 0,
        vpsToClient: Number.isFinite(stages.vpsToClient) ? Math.max(0, stages.vpsToClient) : 0,
        done: Number.isFinite(stages.done) ? Math.max(0, stages.done) : 0,
      },
      items: queueItems,
    },
    storage: {
      usedBytes,
      freeBytes,
      totalBytes,
      usedPercent,
    },
  };
};

const defaultClientVaultName = 'My Vault';

const makeClientVault = (patch = {}) => ({
  id: patch.id || crypto.randomUUID(),
  name: String(patch.name || defaultClientVaultName),
  path: String(patch.path || patch.name || defaultClientVaultName),
  vaultRole: 'client',
  relayUrl: normalizeRelayUrl(patch.relayUrl || defaultRelayUrl),
  pairId: patch.pairId || '',
  token: patch.token || '',
  code: patch.code || '',
  codeExpiresAt: patch.codeExpiresAt || '',
  remotePathPrefix: patch.remotePathPrefix || '',
  storageName: patch.storageName || '',
  sizeLabel: patch.sizeLabel || 'Cloud',
  itemCount: Number.isFinite(patch.itemCount) ? patch.itemCount : 0,
  updatedAt: patch.updatedAt || now(),
  status: patch.status || 'offline',
  localMode: patch.localMode || 'online',
  devices: patch.devices?.length ? patch.devices : [],
  progress: Number.isFinite(patch.progress) ? patch.progress : 0,
});

const makeInitialState = () => {
  const deviceId = crypto.randomUUID();
  const role = isServerApp ? 'storage' : 'client';

  return {
    appMode: appFlavor,
    storageNode: {
      name: `${os.hostname()} ${isServerApp ? 'server' : 'storage'}`,
      path: path.join(os.homedir(), isServerApp ? 'Nubem Server' : 'Nubem Storage'),
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
      role,
      status: 'idle',
      storageName: isServerApp ? os.hostname() : '',
    },
    folders: isServerApp ? [] : [makeClientVault()],
    traffic: {
      updatedAt: now(),
      uploadBytesPerSecond: 0,
      downloadBytesPerSecond: 0,
      active: [],
    },
    vpsStats: emptyVpsStats(),
    syncJobs: [],
    activity: [],
    updates: updateDefaults(),
    devices: [
      { id: deviceId, name: os.hostname(), role: isServerApp ? 'Server' : 'Client', status: 'online', address: 'Local' },
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
    const result = spawnSync('systemctl', ['--user', 'is-active', storageServiceName], {
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
  status: ['pending', 'uploading', 'done', 'error'].includes(file.status) ? file.status : 'pending',
  attempts: Number.isFinite(file.attempts) ? file.attempts : 0,
  uploadedBytes: Number.isFinite(file.uploadedBytes) ? file.uploadedBytes : 0,
  error: String(file.error || ''),
});

const normalizeScanDir = (item = {}) => ({
  path: String(item.path || ''),
  entriesPath: String(item.entriesPath || ''),
  offset: Number.isFinite(item.offset) ? item.offset : 0,
});

const normalizeSyncJob = (job = {}) => {
  const files = Array.isArray(job.files) ? job.files.map(normalizeSyncFile).filter((file) => file.sourcePath && file.relativePath) : [];
  const completedFiles = Number.isFinite(job.completedFiles)
    ? Math.max(0, job.completedFiles)
    : files.filter((file) => file.status === 'done').length;
  const completedBytes = Number.isFinite(job.completedBytes)
    ? Math.max(0, job.completedBytes)
    : files.filter((file) => file.status === 'done').reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0);

  return {
    id: String(job.id || crypto.randomUUID()),
    type: 'upload-folder',
    vaultFolderId: String(job.vaultFolderId || ''),
    rootPath: String(job.rootPath || ''),
    rootName: String(job.rootName || 'Folder'),
    status: ['queued', 'running', 'complete', 'error'].includes(job.status) ? job.status : 'queued',
    scanStatus: ['queued', 'scanning', 'complete'].includes(job.scanStatus) ? job.scanStatus : 'complete',
    queuePath: String(job.queuePath || ''),
    queueCursor: Number.isFinite(job.queueCursor) ? Math.max(0, job.queueCursor) : 0,
    scanPendingDirs: Array.isArray(job.scanPendingDirs)
      ? job.scanPendingDirs.map(normalizeScanDir).filter((item) => item.path)
      : [],
    createdAt: String(job.createdAt || now()),
    updatedAt: String(job.updatedAt || now()),
    completedAt: String(job.completedAt || ''),
    nextAttemptAt: String(job.nextAttemptAt || ''),
    lastError: String(job.lastError || ''),
    totalFiles: Number.isFinite(job.totalFiles) ? job.totalFiles : files.length,
    completedFiles,
    completedBytes,
    totalBytes: Number.isFinite(job.totalBytes) ? job.totalBytes : files.reduce((sum, file) => sum + file.sizeBytes, 0),
    files,
  };
};

const normalizeSyncJobs = (jobs) =>
  Array.isArray(jobs)
    ? jobs.map(normalizeSyncJob).filter((job) => job.vaultFolderId && job.rootPath).slice(0, 128)
    : [];

const folderTimestamp = (folder) => {
  const value = new Date(folder?.updatedAt || folder?.createdAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
};

const folderDedupeKey = (folder) => {
  if (folder?.vaultRole === 'client') {
    const vaultPath = String(folder.path || folder.name || '').trim().toLowerCase();
    const remotePathPrefix = String(folder.remotePathPrefix || '').trim().toLowerCase();
    const storageName = String(folder.storageName || '').trim().toLowerCase();
    if (remotePathPrefix && storageName) {
      return `client-prefix:${storageName}:${remotePathPrefix}`;
    }

    if (vaultPath && storageName) {
      return `client:${storageName}:${vaultPath}`;
    }

    if (folder.pairId) {
      return `client-pair:${folder.pairId}`;
    }
  }

  return folder?.id ? `id:${folder.id}` : '';
};

const mergeDuplicateFolders = (older, newer) => ({
  ...older,
  ...newer,
  code: newer.code || older.code,
  codeExpiresAt: newer.codeExpiresAt || older.codeExpiresAt,
  devices: newer.devices?.length ? newer.devices : older.devices,
});

const dedupeFolders = (folders) => {
  const next = [];
  const byKey = new Map();

  for (const folder of folders) {
    const key = folderDedupeKey(folder);
    if (!key) {
      next.push(folder);
      continue;
    }

    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      byKey.set(key, next.length);
      next.push(folder);
      continue;
    }

    const existing = next[existingIndex];
    const [older, newer] = folderTimestamp(folder) >= folderTimestamp(existing) ? [existing, folder] : [folder, existing];
    next[existingIndex] = mergeDuplicateFolders(older, newer);
  }

  return next;
};

const keepSingleClientVault = (folders, pairing = {}) => {
  const clientFolders = folders.filter((folder) => folder.vaultRole === 'client');
  if (clientFolders.length <= 1) {
    return folders;
  }

  const preferred =
    clientFolders.find((folder) => folder.pairId && folder.pairId === pairing.pairId) ||
    clientFolders.slice().sort((left, right) => folderTimestamp(right) - folderTimestamp(left))[0];
  const preferredKey = folderDedupeKey(preferred);

  return folders.filter((folder) => {
    if (folder.vaultRole !== 'client') return true;
    return folder === preferred || folderDedupeKey(folder) === preferredKey;
  });
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

  pairing.role = isServerApp ? 'storage' : 'client';
  pairing.relayUrl = normalizeRelayUrl(pairing.relayUrl);
  if (isServerApp) {
    pairing.storageName = pairing.storageName || currentDevice.name;
  }

  let folders = keepSingleClientVault(dedupeFolders(Array.isArray(state.folders)
    ? state.folders.map((folder) => ({
        ...folder,
        vaultRole: folder.vaultRole || (folder.pairId && pairing.role === 'client' ? 'client' : 'storage'),
        relayUrl: normalizeRelayUrl(folder.relayUrl || pairing.relayUrl || defaultRelayUrl),
      }))
    : []), pairing);

  folders = isServerApp
    ? folders.filter((folder) => folder.vaultRole !== 'client')
    : folders.filter((folder) => folder.vaultRole === 'client');

  if (!isServerApp && !folders.some((folder) => folder.vaultRole === 'client')) {
    folders = [makeClientVault(), ...folders];
  }

  let defaultClientVault = folders.find((folder) => folder.vaultRole === 'client' && folder.pairId && folder.token);
  if (defaultClientVault && (!pairing.pairId || !pairing.token)) {
    pairing.pairId = defaultClientVault.pairId;
    pairing.token = defaultClientVault.token;
    pairing.status = pairing.status === 'idle' ? 'linked' : pairing.status;
    pairing.storageName = pairing.storageName || defaultClientVault.storageName;
  }

  if (!defaultClientVault && pairing.role === 'client' && pairing.pairId && pairing.token) {
    const recoverableIndex = folders.findIndex((folder) => folder.id || folder.path || folder.name);
    if (recoverableIndex !== -1) {
      folders = folders.map((folder, index) =>
        index === recoverableIndex
          ? {
              ...folder,
              vaultRole: 'client',
              pairId: pairing.pairId,
              token: pairing.token,
              storageName: folder.storageName || pairing.storageName,
              localMode: 'online',
            }
          : folder
      );
      defaultClientVault = folders[recoverableIndex];
    }
  }

  folders = keepSingleClientVault(dedupeFolders(folders), pairing);
  const validFolderIds = new Set(folders.map((folder) => folder.id).filter(Boolean));
  const syncJobs = normalizeSyncJobs(state.syncJobs).filter((job) => validFolderIds.has(job.vaultFolderId));

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
    appMode: appFlavor,
    storageNode: {
      ...fresh.storageNode,
      ...(state.storageNode || {}),
      status: storageServiceStatus(),
      relayStatus: relayStatusFromPairing(pairing),
    },
    currentDevice,
    pairing,
    folders,
    syncJobs,
    activity: Array.isArray(state.activity) ? state.activity : [],
    updates: updateDefaults(state.updates, { restoreTransient: restoreUpdates }),
    vpsStats: normalizeVpsStats(state.vpsStats),
    devices: [localDevice, ...devices],
  };
};

const ensureState = () => {
  const file = dataFile();
  if (isServerApp && !fs.existsSync(file) && fs.existsSync(legacyDriveDataFile())) {
    try {
      const legacyState = JSON.parse(fs.readFileSync(legacyDriveDataFile(), 'utf8').replace(/^\uFEFF/, ''));
      const storageFolders = Array.isArray(legacyState.folders)
        ? legacyState.folders.filter((folder) => folder.vaultRole !== 'client')
        : [];

      if (storageFolders.length > 0) {
        writeJsonFileAtomic(file, {
          ...legacyState,
          appMode: 'server',
          pairing: {
            ...(legacyState.pairing || {}),
            role: 'storage',
            status: 'idle',
          },
          folders: storageFolders,
          syncJobs: [],
        });
      }
    } catch {
      // Start fresh if the old client state cannot be read.
    }
  }

  if (!fs.existsSync(file)) {
    writeJsonFileAtomic(file, makeInitialState());
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const rawState = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const state = normalizeState(JSON.parse(rawState), { restoreUpdates: true });
      writeState(state);
      return state;
    } catch {
      if (attempt < 4) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  backupUnreadableState(file);
  const fresh = makeInitialState();
  writeJsonFileAtomic(file, fresh);
  return fresh;
};

const writeState = (state) => {
  const normalized = mergeExistingServerVaultsOnEmptyWrite(dataFile(), normalizeState(state));
  writeJsonFileAtomic(dataFile(), normalized);
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

const storageCredentialsForStats = (state) => {
  const credentials = [];
  const seen = new Set();
  const add = (pairId, token) => {
    const key = `${pairId || ''}:${token || ''}`;
    if (!pairId || !token || seen.has(key)) return;
    seen.add(key);
    credentials.push({ pairId, token });
  };

  if (state.pairing.role === 'storage') {
    add(state.pairing.pairId, state.pairing.token);
  }

  for (const folder of state.folders || []) {
    if (folder.vaultRole === 'storage') {
      add(folder.pairId, folder.token);
    }
  }

  return credentials;
};

const refreshVpsStats = async (state) => {
  if (!isServerApp) return state;

  const relayUrl = normalizeRelayUrl(state.pairing.relayUrl || defaultRelayUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${relayUrl}/api/drive/stats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairs: storageCredentialsForStats(state) }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `Relay ${response.status}`);
    }

    return writeState({
      ...state,
      vpsStats: normalizeVpsStats(payload.stats || payload),
    });
  } catch {
    return writeState({
      ...state,
      vpsStats: normalizeVpsStats(state.vpsStats),
    });
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

const storageReceiveWaitTimeout = (bytes) => {
  const gb = Math.max(1, Math.ceil((Number(bytes) || 0) / (1024 * 1024 * 1024)));
  return Math.min(maxStorageReceiveWaitMs, minStorageReceiveWaitMs + gb * storageReceiveWaitPerGbMs);
};

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

const publicCloudFolders = (state) =>
  state.folders.map((folder) => publicVaultFolder(state, folder));

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

const remoteFoldersFromPayload = (payload) =>
  Array.isArray(payload.folders)
    ? payload.folders.map((folder) => ({
        ...folder,
        path: folder.path || folder.name,
        remotePathPrefix: folder.remotePathPrefix || '',
        sizeBytes: Number.isFinite(folder.sizeBytes) ? folder.sizeBytes : 0,
        sizeLabel: folder.sizeLabel || 'Cloud',
        itemCount: Number.isFinite(folder.itemCount) ? folder.itemCount : 0,
        updatedAt: folder.updatedAt || now(),
        status: folder.status || 'synced',
        localMode: 'online',
        devices: folder.devices?.length ? folder.devices : [payload.storageName || 'Storage PC'],
        progress: Number.isFinite(folder.progress) ? folder.progress : 100,
      }))
    : null;

const mergeClientRemoteFolders = (state, payload) => {
  const remoteFolders = remoteFoldersFromPayload(payload);
  if (!remoteFolders?.length) {
    return null;
  }

  return keepSingleClientVault(dedupeFolders(remoteFolders.map((remoteFolder) => {
    const remotePath = remoteFolder.path || remoteFolder.name;
    const existing = state.folders.find((folder) => {
      if (folder.id === remoteFolder.id) return true;
      const sameStorage = folder.storageName && payload.storageName && folder.storageName === payload.storageName;
      return sameStorage && (folder.path || folder.name) === remotePath;
    });

    return {
      ...existing,
      ...remoteFolder,
      vaultRole: 'client',
      relayUrl: existing?.relayUrl || normalizeRelayUrl(state.pairing.relayUrl || defaultRelayUrl),
      pairId: existing?.pairId || state.pairing.pairId,
      token: existing?.token || state.pairing.token,
      storageName: remoteFolder.storageName || payload.storageName || existing?.storageName,
      remotePathPrefix: remoteFolder.remotePathPrefix || existing?.remotePathPrefix || '',
    };
  })), state.pairing);
};

const applyRelaySnapshot = (state, payload, status = 'linked') => {
  const devices = Array.isArray(payload.devices)
    ? payload.devices.map((device) => mapRelayDevice(device, state.currentDevice.id))
    : state.devices;
  const remoteFolders = state.pairing.role === 'client' ? mergeClientRemoteFolders(state, payload) : null;
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

  return writeState(applyAllVaultSyncStatuses({
    ...state,
    pairing: nextPairing,
    devices,
    folders: remoteFolders?.length ? remoteFolders : state.folders,
  }));
};

const markRelayError = (state, message) => {
  const hasClientVault = state.folders.some((folder) => folder.vaultRole === 'client' && folder.pairId && folder.token);
  return writeState({
    ...state,
    pairing: {
      ...state.pairing,
      status: hasClientVault ? 'offline' : 'error',
      message,
    },
  });
};

const applyVaultPayloadToFolder = (state, folderId, payload, vaultRole) =>
  writeState(applyAllVaultSyncStatuses({
    ...state,
    folders: state.folders.map((folder) => {
      if (folder.id !== folderId) return folder;
      const remoteFolder = Array.isArray(payload.folders) ? payload.folders[0] : null;
      const connectedClients = onlineClientNamesFromPayload(payload, state.currentDevice.id);
      const clientVaults = clientVaultsFromPayload(payload);
      return {
        ...folder,
        ...(remoteFolder && vaultRole === 'client'
          ? {
              name: remoteFolder.name || folder.name,
              path: remoteFolder.path || remoteFolder.name || folder.path,
              remotePathPrefix: remoteFolder.remotePathPrefix || folder.remotePathPrefix || '',
              sizeBytes: Number.isFinite(remoteFolder.sizeBytes) ? remoteFolder.sizeBytes : folder.sizeBytes,
              sizeLabel: remoteFolder.sizeLabel || folder.sizeLabel,
              itemCount: Number.isFinite(remoteFolder.itemCount) ? remoteFolder.itemCount : folder.itemCount,
              updatedAt: remoteFolder.updatedAt || folder.updatedAt,
              status: remoteFolder.status || folder.status,
              localMode: 'online',
              devices: remoteFolder.devices?.length ? remoteFolder.devices : [payload.storageName || 'Storage PC'],
              progress: Number.isFinite(remoteFolder.progress) ? remoteFolder.progress : folder.progress,
            }
          : remoteFolder && vaultRole === 'storage'
            ? {
                sizeBytes: Number.isFinite(remoteFolder.sizeBytes) ? remoteFolder.sizeBytes : folder.sizeBytes,
                sizeLabel: remoteFolder.sizeLabel || folder.sizeLabel,
                itemCount: Number.isFinite(remoteFolder.itemCount) ? remoteFolder.itemCount : folder.itemCount,
                updatedAt: remoteFolder.updatedAt || folder.updatedAt,
                status: folder.status === 'paused' ? 'paused' : remoteFolder.status || 'synced',
                localMode: folder.localMode || 'mirror',
                devices: connectedClients || folder.devices || [],
                clientVaults: clientVaults || folder.clientVaults || [],
                progress: Number.isFinite(remoteFolder.progress) ? remoteFolder.progress : 100,
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
  }));

const shareVault = async (folderId, relayUrl = defaultRelayUrl) => {
  const state = ensureState();
  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder) {
    throw new Error('Vault not found');
  }

  if (folder.pairId && folder.token) {
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

  return writeState(addActivity(nextState, 'vault', folder.name, 'Storage ready'));
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
  if (pairingRefreshWork) {
    return pairingRefreshWork;
  }

  pairingRefreshWork = (async () => {
    let state = await ensureStorageVaultsShared();

    if (!isServerApp && !findDefaultClientVault(state)) {
      try {
        state = await assignClientVault(state);
      } catch (error) {
        state = markRelayError(state, error instanceof Error ? error.message : 'Storage server unavailable');
      }
    }

    const vaults = state.folders.filter((folder) => folder.pairId && folder.token);

    if (vaults.length === 0 && (!state.pairing.pairId || !state.pairing.token)) {
      return refreshVpsStats(state);
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
      } catch {
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
      return refreshVpsStats(state);
    }

    try {
      const payload = await relayRequest(state.pairing.relayUrl, '/api/drive/heartbeat', {
        pairId: state.pairing.pairId,
        token: state.pairing.token,
        device: localRelayDevice(state),
        folders: state.pairing.role === 'storage' ? publicCloudFolders(state) : undefined,
      });
      const nextState = applyRelaySnapshot(state, payload, state.pairing.role === 'storage' ? 'waiting' : 'linked');
      return refreshVpsStats(nextState);
    } catch (error) {
      return refreshVpsStats(markRelayError(state, error instanceof Error ? error.message : 'Relay offline'));
    }
  })();

  try {
    return await pairingRefreshWork;
  } finally {
    pairingRefreshWork = null;
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
    'Storage link',
    'Ready'
  );

  return applyRelaySnapshot(writeState(nextState), payload, 'waiting');
};

const applyClientVaultAssignment = (state, payload, relayUrl, detail = 'Vault ready') => {
  const remoteFolder = Array.isArray(payload.folders) ? payload.folders[0] : null;
  const existingClientVault = state.folders.find((folder) => folder.vaultRole === 'client');
  const folderId = remoteFolder?.id || payload.vault?.id || crypto.randomUUID();
  const joinedVault = makeClientVault({
    ...existingClientVault,
    id: folderId,
    name: existingClientVault?.name || remoteFolder?.name || payload.vault?.name || payload.storageName || defaultClientVaultName,
    path: remoteFolder?.path || remoteFolder?.name || 'Vault',
    remotePathPrefix: remoteFolder?.remotePathPrefix || existingClientVault?.remotePathPrefix || '',
    relayUrl,
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
  });
  const syncJobs = state.syncJobs
    .map((job) => (existingClientVault?.id && job.vaultFolderId === existingClientVault.id ? { ...job, vaultFolderId: folderId } : job))
    .filter((job) => job.vaultFolderId === folderId);
  const nextState = addActivity(
    {
      ...state,
      folders: keepSingleClientVault(dedupeFolders([
        joinedVault,
        ...state.folders.filter((folder) => {
          if (folder.vaultRole === 'client') return false;
          return folder.pairId !== payload.pairId && folder.id !== folderId;
        }),
      ]), { pairId: payload.pairId }),
      syncJobs,
      pairing: {
        relayUrl,
        role: 'client',
        status: 'linked',
        pairId: payload.pairId,
        token: payload.token,
        storageName: payload.storageName,
        message: '',
      },
    },
    'link',
    joinedVault.name,
    detail
  );

  return applyRelaySnapshot(writeState(nextState), payload, 'linked');
};

const assignClientVault = async (state = ensureState()) => {
  const existingClientVault = findDefaultClientVault(state);
  if (isServerApp || existingClientVault) {
    return state;
  }

  const relayUrl = normalizeRelayUrl(state.pairing.relayUrl || defaultRelayUrl);
  const preferredVault = state.folders.find((folder) => folder.vaultRole === 'client') || makeClientVault();
  const payload = await relayRequest(relayUrl, '/api/drive/vaults/assign', {
    device: localRelayDevice(state, 'client'),
    vaultName: preferredVault.name || defaultClientVaultName,
  });

  return applyClientVaultAssignment(state, payload, relayUrl, 'Assigned');
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

  return applyClientVaultAssignment(state, payload, nextRelayUrl, 'Connected');
};

const resetPairing = () => {
  const state = ensureState();
  return writeState(
    addActivity(
      {
        ...state,
        folders: isServerApp
          ? state.folders
          : state.folders.map((folder) =>
              folder.vaultRole === 'client'
                ? makeClientVault({
                    id: folder.id,
                    name: folder.name,
                    path: folder.name,
                    updatedAt: now(),
                    status: 'offline',
                  })
                : folder
            ),
        syncJobs: isServerApp ? state.syncJobs : [],
        pairing: {
          relayUrl: state.pairing.relayUrl || defaultRelayUrl,
          role: isServerApp ? 'storage' : 'client',
          status: 'idle',
          storageName: isServerApp ? state.currentDevice.name : '',
        },
      },
      'link',
      'Link reset',
      'Ready'
    )
  );
};

const cleanVaultName = (value) => String(value || '').trim().replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').slice(0, 80);

const renameVault = (folderId, name) => {
  const state = ensureState();
  const cleanName = cleanVaultName(name);
  if (!cleanName) {
    throw new Error('Name the vault');
  }

  const folder = state.folders.find((item) => item.id === folderId);
  if (!folder || folder.vaultRole !== 'client') {
    throw new Error('Vault not found');
  }

  return writeState(
    addActivity(
      {
        ...state,
        folders: state.folders.map((item) => (item.id === folderId ? { ...item, name: cleanName } : item)),
      },
      'vault',
      cleanName,
      'Renamed'
    )
  );
};

const setServerMode = async (enabled) => {
  if (!isServerApp) {
    throw new Error('Install Nubem Server on the storage PC');
  }

  runUserSystemctl(['daemon-reload']);
  runUserSystemctl([enabled ? 'enable' : 'disable', '--now', storageServiceName]);
  storageServiceStatusCache = { checkedAt: 0, value: 'offline' };

  const state = ensureState();
  const relayUrl = state.pairing.relayUrl || defaultRelayUrl;
  const pairing = {
    relayUrl,
    role: 'storage',
    status: 'idle',
    storageName: state.currentDevice.name,
    message: '',
  };

  return writeState(
    addActivity(
      {
        ...state,
        pairing,
      },
      'link',
      'Server',
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

const normalizeRemoteRelativePath = (relativePath = '') =>
  validateRelativePath(relativePath).split(path.sep).filter(Boolean).join('/');

const joinRemoteRelativePath = (...parts) =>
  parts
    .map((part) => normalizeRemoteRelativePath(part))
    .filter(Boolean)
    .join('/');

const toRemoteRequestPath = (folder, relativePath = '') =>
  folder?.vaultRole === 'client'
    ? joinRemoteRelativePath(folder.remotePathPrefix || '', relativePath)
    : normalizeRemoteRelativePath(relativePath);

const stripRemotePathPrefix = (folder, relativePath = '') => {
  const prefix = normalizeRemoteRelativePath(folder?.remotePathPrefix || '');
  const remotePath = normalizeRemoteRelativePath(relativePath);
  if (!prefix) return remotePath;
  if (remotePath === prefix) return '';
  return remotePath.startsWith(`${prefix}/`) ? remotePath.slice(prefix.length + 1) : remotePath;
};

const stripRemoteListingPrefix = (folder, listing) => {
  if (!listing || folder?.vaultRole !== 'client') return listing;
  const entries = Array.isArray(listing.entries)
    ? listing.entries.map((entry) => ({
        ...entry,
        relativePath: stripRemotePathPrefix(folder, entry.relativePath),
      }))
    : [];

  return {
    ...listing,
    path: stripRemotePathPrefix(folder, listing.path),
    parentPath: stripRemotePathPrefix(folder, listing.parentPath),
    entries,
  };
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

const clientVaultPrefixes = (folder) =>
  new Set((Array.isArray(folder.clientVaults) ? folder.clientVaults : [])
    .map((vault) => normalizeRemoteRelativePath(vault.remotePathPrefix || ''))
    .filter(Boolean));

const ensureKnownClientVaultRoot = (folder, root, target, relativePath = '') => {
  const safeRelativePath = normalizeRemoteRelativePath(relativePath);
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
  const parentPath = currentPath ? currentPath.split('/').slice(0, -1).join('/') : '';

  return {
    folderId,
    path: currentPath,
    parentPath,
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

const createRelayRequest = async (type, folderId, relativePath) => {
  const { folder, pairId, relayUrl, token } = getVaultCredentials(folderId);
  const payload = await relayRequest(relayUrl, '/api/drive/requests/create', {
    pairId,
    token,
    type,
    folderId,
    relativePath: toRemoteRequestPath(folder, relativePath),
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

  while (Date.now() - startedAt < timeoutMs) {
    const payload = await getVaultRequestStatus(folderId, requestId);

    if (payload.status === 'ready') {
      disposeVaultRequest(folderId, requestId).catch(() => undefined);
      return payload.result;
    }

    if (payload.status === 'error') {
      disposeVaultRequest(folderId, requestId).catch(() => undefined);
      throw new Error(payload.error || 'Remote request failed');
    }

    await delay(1200);
  }

  throw new Error('Storage PC did not respond');
};

const getVaultRequestStatus = async (folderId, requestId) => {
  const { pairId, relayUrl, token } = getVaultCredentials(folderId);
  return relayRequest(relayUrl, '/api/drive/requests/result', {
    pairId,
    token,
    requestId,
  });
};

const disposeVaultRequest = async (folderId, requestId) => {
  if (!requestId) return { ok: true };
  const { pairId, relayUrl, token } = getVaultCredentials(folderId);
  return relayRequest(relayUrl, '/api/drive/requests/dispose', {
    pairId,
    token,
    requestId,
  });
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

const uploadRelayBinaryChunk = async (folderId, requestId, index, data) => {
  const { pairId, relayUrl, token } = getVaultCredentials(folderId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), relayChunkWriteTimeoutMs);

  try {
    const response = await fetch(`${normalizeRelayUrl(relayUrl)}/api/drive/requests/chunk-binary`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-nubem-pair-id': pairId,
        'x-nubem-token': token,
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

const downloadRelayBinaryChunk = async (folderId, requestId, index) => {
  const { pairId, relayUrl, token } = getVaultCredentials(folderId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), relayChunkReadTimeoutMs);

  try {
    const response = await fetch(`${normalizeRelayUrl(relayUrl)}/api/drive/requests/chunk-binary`, {
      method: 'POST',
      headers: {
        'x-nubem-pair-id': pairId,
        'x-nubem-token': token,
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

const downloadRelayChunkBuffer = async (folderId, requestId, index) => {
  const { relayUrl } = getVaultCredentials(folderId);
  if (await relaySupportsBinaryChunks(relayUrl)) {
    return downloadRelayBinaryChunk(folderId, requestId, index);
  }

  const chunk = await downloadRelayChunk(folderId, requestId, index);
  return Buffer.from(chunk.data, 'base64');
};

const isChunkMissingError = (error) => String(error?.message || error || '').includes('Chunk missing');

const suggestedDownloadFileName = (relativePath = '') => {
  const safeRelativePath = normalizeRemoteRelativePath(relativePath);
  return safeRelativePath.split('/').filter(Boolean).pop() || 'download';
};

const writeStreamBuffer = (stream, buffer) =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    if (stream.write(buffer)) {
      resolve();
      return;
    }

    stream.once('drain', onDrain);
    stream.once('error', onError);
  });

const waitForProgressiveDownload = async (folderId, requestId, stream, timeoutMs = 15 * 60 * 1000) => {
  const startedAt = Date.now();
  let nextChunk = 0;
  let result = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const chunk = await downloadRelayChunkBuffer(folderId, requestId, nextChunk);
      await writeStreamBuffer(stream, chunk);
      nextChunk += 1;
      continue;
    } catch (error) {
      if (!isChunkMissingError(error)) {
        throw error;
      }
    }

    const status = await getVaultRequestStatus(folderId, requestId);
    if (status.status === 'error') {
      disposeVaultRequest(folderId, requestId).catch(() => undefined);
      throw new Error(status.error || 'Remote request failed');
    }

    if (status.status === 'ready') {
      result = status.result || {};
      if (nextChunk >= Number(result.chunkCount || 0)) {
        disposeVaultRequest(folderId, requestId).catch(() => undefined);
        return result;
      }
    }

    await delay(200);
  }

  throw new Error('Storage PC did not respond');
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
  const { relayUrl } = getVaultCredentials(folderId);
  const useBinaryChunks = await relaySupportsBinaryChunks(relayUrl);

  try {
    while (offset < stat.size) {
      const bytesRead = fs.readSync(file, buffer, 0, Math.min(chunkSize, stat.size - offset), offset);
      if (bytesRead <= 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (useBinaryChunks) {
        await uploadRelayBinaryChunk(folderId, requestId, index, chunk);
      } else {
        await uploadRelayChunk(folderId, requestId, index, chunk.toString('base64'));
      }
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
  let completed = false;
  let receiveError = null;
  try {
    for (let index = 0; index < Number(request.chunkCount || 0); index += 1) {
      const chunk = await downloadRelayChunkBuffer(vaultFolderId, request.id, index);
      stream.write(chunk);
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
  const listing = await waitForVaultRequest(folderId, requestId);
  const folder = ensureState().folders.find((item) => item.id === folderId);
  return stripRemoteListingPrefix(folder, listing);
};

const downloadRemoteFile = async (folderId, relativePath = '') => {
  const state = ensureState();

  if (state.pairing.role === 'storage') {
    const { target } = resolveCloudPath(state, folderId, relativePath);
    shell.showItemInFolder(target);
    return { ok: true, filePath: target };
  }

  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: `Save from ${appProductName}`,
    defaultPath: suggestedDownloadFileName(relativePath),
  });

  if (saveResult.canceled || !saveResult.filePath) {
    return { ok: false };
  }

  const requestId = await createRelayRequest('download', folderId, relativePath);
  const tmpTarget = `${saveResult.filePath}.nubem-part-${requestId}`;
  const stream = fs.createWriteStream(tmpTarget);
  let result = null;
  let downloadError = null;

  try {
    result = await waitForProgressiveDownload(folderId, requestId, stream, 15 * 60 * 1000);
  } catch (error) {
    downloadError = error;
  } finally {
    await new Promise((resolve, reject) => {
      stream.end((error) => (error ? reject(error) : resolve()));
    });
  }

  if (downloadError) {
    fs.rmSync(tmpTarget, { force: true });
    throw downloadError;
  }

  fs.rmSync(saveResult.filePath, { force: true });
  fs.renameSync(tmpTarget, saveResult.filePath);
  if (result?.modifiedAt) {
    const modifiedAt = new Date(result.modifiedAt);
    if (Number.isFinite(modifiedAt.getTime())) {
      fs.utimesSync(saveResult.filePath, modifiedAt, modifiedAt);
    }
  }

  writeState(addActivity(ensureState(), 'download', result?.fileName || suggestedDownloadFileName(relativePath), result?.sizeLabel || 'Downloaded'));
  return { ok: true, filePath: saveResult.filePath };
};

const createShareLink = async (folderId, relativePath = '', type = 'file', name = '') => {
  const { folder, pairId, relayUrl, token } = getVaultCredentials(folderId);
  const safeRelativePath = normalizeRemoteRelativePath(relativePath);
  if (!safeRelativePath) {
    throw new Error('Select a file or folder');
  }

  const payload = await relayRequest(relayUrl, '/api/drive/shares/create', {
    pairId,
    token,
    folderId,
    relativePath: toRemoteRequestPath(folder, safeRelativePath),
    type: type === 'directory' ? 'directory' : 'file',
    name: name || path.basename(safeRelativePath),
  });

  if (!payload.share?.url) {
    throw new Error('Could not create share link');
  }

  writeState(addActivity(ensureState(), 'link', payload.share.name || name || path.basename(safeRelativePath), 'Share link created'));
  return payload.share;
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

const requireDeleteResult = (result) => {
  if (result?.deletedAt && (result.type === 'file' || result.type === 'folder') && result.relativePath) {
    return result;
  }

  throw new Error('Storage PC needs the latest Nubem Drive to delete from vault');
};

const remotePathMatchesDelete = (relativePath = '', deletedPath = '', deletedType = 'folder') => {
  const remotePath = normalizeRemoteRelativePath(relativePath);
  const safeDeletedPath = normalizeRemoteRelativePath(deletedPath);
  if (!remotePath || !safeDeletedPath) return false;
  if (remotePath === safeDeletedPath) return true;
  return deletedType === 'folder' && remotePath.startsWith(`${safeDeletedPath}/`);
};

const removeDeletedPathFromSyncJobs = (state, vaultFolderId, deleteResult) => {
  const deletedPath = normalizeRemoteRelativePath(deleteResult?.relativePath || '');
  const deletedType = deleteResult?.type === 'file' ? 'file' : 'folder';
  if (!deletedPath) return state;

  let changed = false;
  const syncJobs = [];

  for (const job of state.syncJobs) {
    if (job.vaultFolderId !== vaultFolderId) {
      syncJobs.push(job);
      continue;
    }

    const nextFiles = job.files.filter((file) => !remotePathMatchesDelete(file.relativePath, deletedPath, deletedType));
    if (nextFiles.length === job.files.length) {
      syncJobs.push(job);
      continue;
    }

    changed = true;
    if (nextFiles.length === 0) {
      continue;
    }

    const totalBytes = nextFiles.reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0);
    syncJobs.push(normalizeSyncJob({
      ...job,
      files: nextFiles,
      totalFiles: nextFiles.length,
      totalBytes,
      updatedAt: now(),
    }));
  }

  return changed ? applyVaultSyncStatus({ ...state, syncJobs }, vaultFolderId) : state;
};

const cancelSyncJob = async (jobId) => {
  const state = ensureState();
  const job = state.syncJobs.find((item) => item.id === jobId);
  if (!job) {
    return state;
  }

  const result = await dialog.showMessageBox(mainWindow || createWindow(), {
    type: 'warning',
    buttons: ['Cancel upload', 'Keep uploading'],
    defaultId: 1,
    cancelId: 1,
    title: 'Cancel upload',
    message: `Cancel upload of "${job.rootName}"?`,
    detail: 'Files already stored in the vault stay there. Pending files will not be uploaded.',
  });

  if (result.response !== 0) {
    return ensureState();
  }

  cleanupSyncJobFiles(job);
  const nextState = addActivity(
    applyVaultSyncStatus(
      {
        ...state,
        syncJobs: state.syncJobs.filter((item) => item.id !== jobId),
      },
      job.vaultFolderId
    ),
    'remove',
    job.rootName,
    'Upload canceled'
  );

  return writeState(nextState);
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
      : await waitForVaultRequest(folderId, await createRelayRequest('delete', folderId, safeRelativePath), timeoutMs)
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
  const nextState = removeDeletedPathFromSyncJobs(ensureState(), folderId, deleteResult);
  writeState(addActivity(nextState, 'remove', deleteResult.name || name, 'Deleted from vault'));
  return { ok: true, deleted: deleteResult };
};

const findDefaultClientVault = (state) => state.folders.find((folder) => folder.vaultRole === 'client' && folder.pairId && folder.token);

const isStorageDevice = (device) => {
  const role = String(device?.role || '').toLowerCase();
  return role.includes('storage') || role === 'server';
};

const isVaultStorageOnline = (state) => state.devices.some((device) => isStorageDevice(device) && device.status === 'online');

const appendJsonLines = (file, items) => {
  if (!items.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${items.map((item) => JSON.stringify(item)).join('\n')}\n`);
};

const readJsonLineBatch = (file, offset = 0, limit = 1) => {
  if (!file || !fs.existsSync(file) || limit <= 0) {
    return { items: [], nextOffset: offset, eof: true };
  }

  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  const items = [];
  let position = Math.max(0, offset);
  let remainder = '';

  try {
    while (items.length < limit) {
      const chunkStart = position;
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead <= 0) {
        return { items, nextOffset: position, eof: true };
      }

      const text = remainder + buffer.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      remainder = lines.pop() || '';
      let consumedBytes = 0;

      for (const line of lines) {
        consumedBytes += Buffer.byteLength(`${line}\n`);
        if (!line.trim()) continue;

        try {
          items.push(JSON.parse(line));
        } catch {
          // Ignore corrupt queue lines and continue with the next file.
        }

        if (items.length >= limit) {
          return { items, nextOffset: chunkStart + consumedBytes, eof: false };
        }
      }

      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }

  return { items, nextOffset: position, eof: false };
};

const makeQueuedSyncFile = (root, rootName, sourcePath, stat) => ({
  sourcePath,
  relativePath: [rootName, relativeCloudPath(root, sourcePath)].filter(Boolean).join('/'),
  sizeBytes: stat.size,
  modifiedAt: stat.mtime.toISOString(),
  status: 'pending',
  attempts: 0,
  uploadedBytes: 0,
  error: '',
});

const createUploadRequest = async (vaultFolderId, relativePath, fileName, totalBytes, chunkCount, modifiedAt = '', chunkFormat = 'base64') => {
  const { folder, pairId, relayUrl, token } = getVaultCredentials(vaultFolderId);
  const payload = await relayRequest(relayUrl, '/api/drive/requests/create', {
    pairId,
    token,
    type: 'upload',
    folderId: vaultFolderId,
    relativePath: toRemoteRequestPath(folder, relativePath),
    fileName,
    totalBytes,
    sizeLabel: formatBytes(totalBytes),
    chunkCount,
    chunkFormat,
    modifiedAt,
  });

  return payload.requestId;
};

const uploadFileToVault = async (vaultFolderId, sourceFile, targetRelativePath, metadata = {}, onProgress = () => undefined) => {
  const stat = fs.statSync(sourceFile);
  const chunkSize = relayChunkSize;
  const chunkCount = Math.max(1, Math.ceil(stat.size / chunkSize));
  const modifiedAt = metadata.modifiedAt || stat.mtime.toISOString();
  let requestId = '';
  let file;
  const buffer = Buffer.alloc(chunkSize);
  let index = 0;
  let offset = 0;
  let uploadReady = false;

  try {
    file = fs.openSync(sourceFile, 'r');
    const { relayUrl } = getVaultCredentials(vaultFolderId);
    const useBinaryChunks = await relaySupportsBinaryChunks(relayUrl);
    requestId = await createUploadRequest(
      vaultFolderId,
      targetRelativePath,
      path.basename(sourceFile),
      stat.size,
      chunkCount,
      modifiedAt,
      useBinaryChunks ? 'binary' : 'base64'
    );

    if (stat.size === 0) {
      if (useBinaryChunks) {
        await uploadRelayBinaryChunk(vaultFolderId, requestId, 0, Buffer.alloc(0));
      } else {
        await uploadRelayChunk(vaultFolderId, requestId, 0, Buffer.alloc(0).toString('base64'));
      }
    }

    while (offset < stat.size) {
      const bytesRead = fs.readSync(file, buffer, 0, Math.min(chunkSize, stat.size - offset), offset);
      if (bytesRead <= 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (useBinaryChunks) {
        await uploadRelayBinaryChunk(vaultFolderId, requestId, index, chunk);
      } else {
        await uploadRelayChunk(vaultFolderId, requestId, index, chunk.toString('base64'));
      }
      offset += bytesRead;
      index += 1;
      onProgress(offset, stat.size);
    }

    await markUploadReady(vaultFolderId, requestId);
    uploadReady = true;
    onProgress(stat.size, stat.size);
    return await waitForVaultRequest(vaultFolderId, requestId, storageReceiveWaitTimeout(stat.size));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload failed';
    if (requestId && !uploadReady) {
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
  const id = crypto.randomUUID();
  const root = path.resolve(folderPath);
  const rootName = path.basename(root) || 'Folder';
  const queuePath = syncQueueFile(id);
  const stat = fs.statSync(root);
  let scanStatus = 'complete';
  let totalFiles = 0;
  let totalBytes = 0;
  let scanPendingDirs = [];

  fs.mkdirSync(syncQueueRoot(), { recursive: true });
  fs.rmSync(queuePath, { force: true });

  if (stat.isDirectory()) {
    scanStatus = 'queued';
    scanPendingDirs = [{ path: root, entriesPath: syncScanDirFile(id, root), offset: 0 }];
  } else if (stat.isFile()) {
    const file = makeQueuedSyncFile(root, rootName, root, stat);
    appendJsonLines(queuePath, [file]);
    totalFiles = 1;
    totalBytes = stat.size;
  }

  return normalizeSyncJob({
    id,
    type: 'upload-folder',
    vaultFolderId,
    rootPath: root,
    rootName,
    status: stat.isFile() || stat.isDirectory() ? 'queued' : 'complete',
    scanStatus,
    queuePath,
    queueCursor: 0,
    scanPendingDirs,
    createdAt: now(),
    updatedAt: now(),
    completedAt: '',
    totalFiles,
    completedFiles: 0,
    completedBytes: 0,
    totalBytes,
    files: [],
  });
};

const syncJobProgress = (job) => {
  const completedFiles = Number(job.completedFiles || 0);
  const totalFiles = Math.max(job.totalFiles, job.files.length, 0);
  return {
    completedFiles,
    totalFiles,
    progress: totalFiles === 0 ? 0 : Math.round((completedFiles / totalFiles) * 100),
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

const applyAllVaultSyncStatuses = (state) => {
  const vaultFolderIds = Array.from(new Set(state.syncJobs.map((job) => job.vaultFolderId).filter(Boolean)));
  return vaultFolderIds.reduce((nextState, vaultFolderId) => applyVaultSyncStatus(nextState, vaultFolderId), state);
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
  updateSyncJob(jobId, (job) => {
    const previous = job.files.find((item) => item.relativePath === file.relativePath);
    const shouldCount = previous?.status !== 'done';
    const sizeBytes = Number(patch.sizeBytes ?? file.sizeBytes ?? previous?.sizeBytes ?? 0) || 0;

    return {
      ...job,
      completedFiles: shouldCount ? Number(job.completedFiles || 0) + 1 : Number(job.completedFiles || 0),
      completedBytes: shouldCount ? Number(job.completedBytes || 0) + sizeBytes : Number(job.completedBytes || 0),
      lastError: '',
      nextAttemptAt: '',
      files: job.files.map((item) =>
        item.relativePath === file.relativePath
          ? {
              ...item,
              ...patch,
              status: 'done',
              error: '',
              uploadedBytes: Number(item.sizeBytes || sizeBytes || 0),
            }
          : item
      ),
    };
  });

const markSyncFileRetry = (jobId, file, message) => {
  const attempts = Number(file.attempts || 0) + 1;
  const delayMs = Math.min(5 * 60 * 1000, 10_000 * attempts);
  return updateSyncFile(
    jobId,
    file.relativePath,
    {
      status: 'pending',
      attempts,
      uploadedBytes: 0,
      error: message,
    },
    {
      status: 'queued',
      lastError: message,
      nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
    }
  );
};

const ensureScanEntriesFile = (job, dirState) => {
  const entriesPath = dirState.entriesPath || syncScanDirFile(job.id, dirState.path);
  if (fs.existsSync(entriesPath)) {
    return entriesPath;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(dirState.path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
      }));
  } catch {
    entries = [];
  }

  appendJsonLines(entriesPath, entries);
  if (entries.length === 0) {
    fs.closeSync(fs.openSync(entriesPath, 'a'));
  }
  return entriesPath;
};

const scanSyncJobBatch = (jobId) => {
  const state = ensureState();
  const job = state.syncJobs.find((item) => item.id === jobId);
  if (!job || job.scanStatus === 'complete') {
    return state;
  }

  const pendingDirs = [...job.scanPendingDirs];
  const queuedFiles = [];
  let processedEntries = 0;

  while (pendingDirs.length > 0 && queuedFiles.length < syncScanFilesPerBatch && processedEntries < syncScanEntriesPerBatch) {
    const currentDir = pendingDirs.shift();
    const entriesPath = ensureScanEntriesFile(job, currentDir);
    const readLimit = Math.min(syncScanEntriesPerBatch - processedEntries, syncScanFilesPerBatch - queuedFiles.length);
    const batch = readJsonLineBatch(entriesPath, currentDir.offset || 0, Math.max(1, readLimit));
    processedEntries += batch.items.length;

    for (const entry of batch.items) {
      const target = path.join(currentDir.path, entry.name);
      if (entry.type === 'directory') {
        pendingDirs.push({ path: target, entriesPath: syncScanDirFile(job.id, target), offset: 0 });
        continue;
      }

      try {
        const stat = fs.statSync(target);
        if (stat.isFile()) {
          queuedFiles.push(makeQueuedSyncFile(job.rootPath, job.rootName, target, stat));
        }
      } catch {
        // Files can disappear while scanning. Skip them and continue.
      }
    }

    if (!batch.eof) {
      pendingDirs.unshift({ ...currentDir, entriesPath, offset: batch.nextOffset });
    } else {
      fs.rmSync(entriesPath, { force: true });
    }
  }

  appendJsonLines(job.queuePath || syncQueueFile(job.id), queuedFiles);

  return updateSyncJob(jobId, (current) => ({
    ...current,
    scanStatus: pendingDirs.length > 0 ? 'scanning' : 'complete',
    scanPendingDirs: pendingDirs,
    status: current.status === 'running' ? 'running' : 'queued',
    totalFiles: Number(current.totalFiles || 0) + queuedFiles.length,
    totalBytes: Number(current.totalBytes || 0) + queuedFiles.reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0),
    lastError: pendingDirs.length > 0 ? 'Scanning files' : current.lastError,
    nextAttemptAt: '',
  }));
};

const readQueuedSyncFiles = (job, limit) => {
  const batch = readJsonLineBatch(job.queuePath || syncQueueFile(job.id), job.queueCursor || 0, limit);
  return {
    files: batch.items.map(normalizeSyncFile).filter((file) => file.sourcePath && file.relativePath),
    nextCursor: batch.nextOffset,
    eof: batch.eof,
  };
};

const cleanupSyncJobFiles = (job) => {
  fs.rmSync(job.queuePath || syncQueueFile(job.id), { force: true });
  try {
    for (const entry of fs.readdirSync(syncQueueRoot())) {
      if (entry.startsWith(`${job.id}.`) && entry.endsWith('.entries.jsonl')) {
        fs.rmSync(path.join(syncQueueRoot(), entry), { force: true });
      }
    }
  } catch {
    // Queue cleanup should not block sync completion.
  }
};

const finishSyncJob = (jobId) => {
  const state = updateSyncJob(jobId, (job) => ({
    ...job,
    status: 'complete',
    scanStatus: 'complete',
    completedAt: now(),
    lastError: '',
    nextAttemptAt: '',
    files: [],
  }));
  const job = state.syncJobs.find((item) => item.id === jobId);
  if (job) {
    cleanupSyncJobFiles(job);
    writeState(addActivity(ensureState(), 'upload', job.rootName, `${syncJobProgress(job).totalFiles} files uploaded`));
  }
  return ensureState();
};

const enqueueUploadJobs = (state, vaultFolderId, folderPaths) => {
  const activeKeys = new Set(
    state.syncJobs
      .filter((job) => job.status !== 'complete')
      .map((job) => `${job.vaultFolderId}:${path.resolve(job.rootPath)}`)
  );
  const replacementKeys = new Set();
  const jobs = [];

  for (const sourcePath of resolveUploadPaths(folderPaths)) {
    const root = path.resolve(sourcePath);
    const key = `${vaultFolderId}:${root}`;
    if (activeKeys.has(key)) {
      continue;
    }

    const job = makeUploadJob(vaultFolderId, root);
    if (job.status === 'complete' && job.totalFiles === 0) {
      continue;
    }

    jobs.push(job);
    activeKeys.add(key);
    replacementKeys.add(key);
  }

  if (jobs.length === 0) {
    return { state, jobs };
  }

  const fileCount = jobs.reduce((sum, job) => sum + job.totalFiles, 0);
  const isScanning = jobs.some((job) => job.scanStatus !== 'complete');
  const nextState = addActivity(
    applyVaultSyncStatus(
      {
        ...state,
        syncJobs: [
          ...state.syncJobs.filter((job) => !replacementKeys.has(`${job.vaultFolderId}:${path.resolve(job.rootPath)}`)),
          ...jobs,
        ],
      },
      vaultFolderId
    ),
    'upload',
    jobs.length === 1 ? jobs[0].rootName : `${jobs.length} folders`,
    isScanning ? 'Scanning files' : `${fileCount} files queued`
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

const hasRunningSyncJob = (state = ensureState()) => state.syncJobs.some((job) => job.status === 'running');

const processSyncFileUpload = async (jobId, job, file) => {
  if (!fs.existsSync(file.sourcePath)) {
    markSyncFileDone(jobId, file, { error: 'Source missing' });
    return;
  }

  const stat = fs.statSync(file.sourcePath);
  if (!stat.isFile()) {
    markSyncFileDone(jobId, file, { error: 'Source skipped' });
    return;
  }

  const currentFile = {
    ...file,
    status: 'uploading',
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };

  updateSyncFile(jobId, file.relativePath, {
    status: 'uploading',
    sizeBytes: currentFile.sizeBytes,
    modifiedAt: currentFile.modifiedAt,
    uploadedBytes: 0,
    error: '',
  });

  if (!(await remoteFileMatches(job.vaultFolderId, currentFile))) {
    await uploadFileToVault(
      job.vaultFolderId,
      currentFile.sourcePath,
      currentFile.relativePath,
      currentFile,
      (uploadedBytes, totalBytes) => {
        const isWaitingForStorage = uploadedBytes >= totalBytes;
        updateSyncFile(job.id, currentFile.relativePath, {
          status: isWaitingForStorage ? 'pending' : 'uploading',
          uploadedBytes,
          error: isWaitingForStorage
            ? 'Waiting for storage'
            : `Uploading ${formatBytes(uploadedBytes)} of ${formatBytes(totalBytes)}`,
        });
      }
    );
  }

  markSyncFileDone(jobId, currentFile, {
    sizeBytes: currentFile.sizeBytes,
    modifiedAt: currentFile.modifiedAt,
  });
};

const processUploadJob = async (jobId) => {
  let state = updateSyncJob(jobId, (job) => ({
    ...job,
    status: 'running',
    lastError: '',
    nextAttemptAt: '',
    files: job.files.map((file) =>
      file.status === 'uploading'
        ? { ...file, status: 'pending', uploadedBytes: 0, error: '' }
        : file
    ),
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

    if (!isVaultStorageOnline(state)) {
      return updateSyncJob(jobId, (current) => ({
        ...current,
        status: 'queued',
        lastError: 'Storage PC is offline',
        nextAttemptAt: new Date(Date.now() + 30_000).toISOString(),
        files: current.files.map((item) =>
          item.status !== 'done' && item.relativePath === current.files.find((file) => file.status !== 'done')?.relativePath
            ? { ...item, uploadedBytes: 0, error: 'Waiting for Storage PC' }
            : item
        ),
      }));
    }

    const staleUploadingFiles = job.files.filter((item) => item.status === 'uploading');
    if (staleUploadingFiles.length > 0) {
      updateSyncJob(jobId, (current) => ({
        ...current,
        files: current.files.map((file) =>
          file.status === 'uploading'
            ? { ...file, status: 'pending', uploadedBytes: 0, error: '' }
            : file
        ),
      }));
      continue;
    }

    const pendingFiles = job.files.filter((item) => item.status !== 'done');
    let runnableFiles = pendingFiles;
    if (runnableFiles.length === 0) {
      if (job.scanStatus !== 'complete') {
        scanSyncJobBatch(jobId);
      }

      const refreshed = ensureState().syncJobs.find((item) => item.id === jobId);
      if (!refreshed) {
        return ensureState();
      }

      const queuedBatch = readQueuedSyncFiles(refreshed, syncUploadConcurrency);
      if (queuedBatch.files.length > 0) {
        updateSyncJob(jobId, (current) => ({
          ...current,
          queueCursor: queuedBatch.nextCursor,
          files: queuedBatch.files,
          status: 'running',
          lastError: '',
          nextAttemptAt: '',
        }));
        continue;
      }

      if (refreshed.scanStatus === 'complete') {
        return finishSyncJob(jobId);
      }

      return updateSyncJob(jobId, (current) => ({
        ...current,
        status: 'queued',
        lastError: 'Scanning files',
        nextAttemptAt: new Date(Date.now() + 1000).toISOString(),
      }));
    }

    const batch = runnableFiles.slice(0, syncUploadConcurrency);
    const batchPaths = new Set(batch.map((file) => file.relativePath));
    updateSyncJob(jobId, (current) => ({
      ...current,
      status: 'running',
      lastError: '',
      nextAttemptAt: '',
      files: current.files.map((file) =>
        batchPaths.has(file.relativePath)
          ? { ...file, status: 'uploading', uploadedBytes: 0, error: '' }
          : file
      ),
    }));

    const results = await Promise.allSettled(batch.map((file) => processSyncFileUpload(jobId, job, file)));
    const failed = results
      .map((result, index) => ({ result, file: batch[index] }))
      .filter(({ result }) => result.status === 'rejected');

    if (failed.length > 0) {
      for (const { result, file } of failed) {
        const message = result.reason instanceof Error ? result.reason.message : 'Upload failed';
        markSyncFileRetry(jobId, file, message);
      }
      return ensureState();
    }
  }
};

const processUploadJobs = async () => {
  if (syncWork) return syncWork;

  syncWorkStartedAt = Date.now();
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
    syncWorkStartedAt = 0;
  });

  return syncWork;
};

const wakeSyncProcessor = () => {
  const state = ensureState();
  if (syncWork && syncWorkStartedAt && Date.now() - syncWorkStartedAt > 2 * 60 * 1000 && !hasRunningSyncJob(state)) {
    syncWork = null;
    syncWorkStartedAt = 0;
  }

  if (nextRunnableSyncJob()) {
    processUploadJobs().catch(() => undefined);
  }
};

const startSyncProcessor = () => {
  if (syncTimer) return;

  setTimeout(() => {
    wakeSyncProcessor();
  }, 1000);

  syncTimer = setInterval(() => {
    wakeSyncProcessor();
  }, 5000);
};

const recoverInterruptedSyncJobs = () => {
  const state = ensureState();
  let changed = false;
  const syncJobs = state.syncJobs.map((job) => {
    if (job.status === 'complete' || job.status === 'error') return job;

    const hasUploadingFiles = job.files.some((file) => file.status === 'uploading');
    if (job.status !== 'running' && !hasUploadingFiles) return job;

    changed = true;
    return normalizeSyncJob({
      ...job,
      status: 'queued',
      nextAttemptAt: '',
      lastError: job.lastError || 'Interrupted; retrying',
      files: job.files.map((file) =>
        file.status === 'uploading'
          ? { ...file, status: 'pending', uploadedBytes: 0, error: 'Interrupted; retrying' }
          : file
      ),
    });
  });

  if (!changed) {
    return writeState(applyAllVaultSyncStatuses(state));
  }

  return writeState(applyAllVaultSyncStatuses({ ...state, syncJobs }));
};

const cloudFoldersToDefaultVault = async (folderPaths) => {
  let state = ensureState();
  let vault = findDefaultClientVault(state);

  if (!vault && state.pairing.role === 'client') {
    state = await assignClientVault(state);
    vault = findDefaultClientVault(state);
  }

  if (!vault) {
    focusMainWindow();
    throw new Error('Nubem storage unavailable');
  }

  const result = enqueueUploadJobs(state, vault.id, folderPaths);
  if (result.jobs.length === 0) {
    throw new Error('No files found to upload');
  }

  state = result.state;
  wakeSyncProcessor();

  return state;
};

const removeCloudFoldersFromDefaultVault = async (folderPaths, options = {}) => {
  let state = ensureState();
  const vault = findDefaultClientVault(state);

  if (!vault) {
    focusMainWindow();
    throw new Error('Nubem storage unavailable');
  }

  const roots = resolveUploadPaths(folderPaths).map((folderPath) => path.resolve(folderPath));
  const matches = state.syncJobs.filter(
    (job) => job.vaultFolderId === vault.id && roots.includes(path.resolve(job.rootPath))
  );

  if (matches.length === 0) {
    throw new Error('File or folder is not in Nubem');
  }

  const uniqueRoots = Array.from(new Map(matches.map((job) => [path.resolve(job.rootPath), job])).values());
  const label = uniqueRoots.length === 1 ? uniqueRoots[0].rootName : `${uniqueRoots.length} folders`;
  const shouldConfirm = options.confirm !== false;
  if (shouldConfirm) {
    const result = await dialog.showMessageBox(createWindow(), {
      type: 'warning',
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Remove from Nubem',
      message: `Remove "${label}" from Nubem?`,
      detail: 'Files stay on this computer. The vault copy is removed from the storage PC for paired devices.',
    });

    if (result.response !== 0) {
      return ensureState();
    }
  }

  for (const job of uniqueRoots) {
    const rootMatches = matches.filter((match) => path.resolve(match.rootPath) === path.resolve(job.rootPath));
    const hasRemoteFiles = rootMatches.some((match) => match.status !== 'queued' || syncJobProgress(match).completedFiles > 0);
    if (hasRemoteFiles) {
      await deleteVaultRelativePath(vault.id, job.rootName, 120_000);
    }
  }

  state = ensureState();
  const removedRootPaths = new Set(uniqueRoots.map((job) => path.resolve(job.rootPath)));
  const nextState = addActivity(
    applyVaultSyncStatus(
      {
        ...state,
        syncJobs: state.syncJobs.filter((job) => (
          job.vaultFolderId !== vault.id || !removedRootPaths.has(path.resolve(job.rootPath))
        )),
      },
      vault.id
    ),
    'remove',
    label,
    'Removed from Nubem'
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
          title: appProductName,
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

const resolveUploadPaths = (paths) =>
  paths
    .map((sourcePath) => path.resolve(sourcePath))
    .filter((sourcePath) => {
      try {
        const stat = fs.statSync(sourcePath);
        return stat.isDirectory() || stat.isFile();
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

const addVaultsFromPaths = async (folderPaths, detail = 'Storage added') => {
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
  new Notification({ title: appProductName, body }).show();
};

const notifyCloudUploadStarted = (folders) => {
  if (!Notification.isSupported()) {
    return;
  }

  const body = folders.length === 1 ? `Queuing ${folders[0].name}` : `Queuing ${folders.length} folders`;
  new Notification({ title: appProductName, body }).show();
};

const notifyCloudRemoveStarted = (folders) => {
  if (!Notification.isSupported()) {
    return;
  }

  const body = folders.length === 1 ? `Removing ${folders[0].name}` : `Removing ${folders.length} folders`;
  new Notification({ title: appProductName, body }).show();
};

const notifyCloudRemoved = (folders) => {
  if (!Notification.isSupported()) {
    return;
  }

  const body = folders.length === 1 ? `${folders[0].name} removed` : `${folders.length} folders removed`;
  new Notification({ title: appProductName, body }).show();
};

const notifyCloudError = (message) => {
  if (!Notification.isSupported()) {
    return;
  }

  new Notification({ title: appProductName, body: message }).show();
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
    title: appProductName,
    icon: appIconPath(),
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
  let state = ensureState();
  let clientVault = findDefaultClientVault(state);
  if (!clientVault && state.pairing.role === 'client') {
    try {
      state = await assignClientVault(state);
      clientVault = findDefaultClientVault(state);
    } catch (error) {
      focusMainWindow();
      notifyCloudError(error instanceof Error ? error.message : 'Nubem storage unavailable');
      return;
    }
  }

  if (clientVault) {
    const folders = resolveUploadPaths(folderPaths).map((folderPath) => ({ name: path.basename(folderPath) || folderPath }));
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
    notifyCloudError('Nubem storage unavailable');
    return;
  }

  const { added } = await addVaultsFromPaths(folderPaths, 'Storage added from context menu');
  if (added.length > 0) {
    notifyClouded(added);
  }
};

const removeCloudFoldersAndNotify = async (folderPaths, options = {}) => {
  const folders = resolveUploadPaths(folderPaths).map((folderPath) => ({ name: path.basename(folderPath) || folderPath }));
  if (folders.length === 0) {
    notifyCloudError('Select a file or folder to remove');
    return;
  }

  focusMainWindow();
  notifyCloudRemoveStarted(folders);

  try {
    await removeCloudFoldersFromDefaultVault(folderPaths, options);
    notifyCloudRemoved(folders);
  } catch (error) {
    writeCommandLog('remove-failed', {
      paths: folderPaths,
      error: error instanceof Error ? error.message : String(error),
    });
    notifyCloudError(error instanceof Error ? error.message : 'Could not remove from Nubem');
  }
};

const commandQueueDir = () => path.join(app.getPath('userData'), 'commands');

const writeCommandLog = (event, detail = {}) => {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'commands.log'),
      `${JSON.stringify({ at: now(), event, ...detail })}\n`
    );
  } catch {
    // Command logging should never block context menu handling.
  }
};

const processQueuedCommands = async () => {
  if (commandWork) {
    return commandWork;
  }

  commandWork = (async () => {
    let entries = [];
    try {
      entries = fs.readdirSync(commandQueueDir())
        .filter((entry) => entry.toLowerCase().endsWith('.json'))
        .sort();
    } catch {
      return;
    }

    for (const entry of entries) {
      const commandPath = path.join(commandQueueDir(), entry);
      let command;
      try {
        command = JSON.parse(fs.readFileSync(commandPath, 'utf8').replace(/^\uFEFF/, ''));
      } catch {
        writeCommandLog('invalid-json', { file: entry });
        fs.rmSync(commandPath, { force: true });
        continue;
      }

      fs.rmSync(commandPath, { force: true });

      const paths = Array.isArray(command.paths) ? command.paths.map(String).filter(Boolean) : [];
      writeCommandLog('received', { type: command.type, paths });
      if (command.type === 'cloud-folder' && paths.length > 0) {
        try {
          await cloudFoldersAndNotify(paths);
          writeCommandLog('completed', { type: command.type, paths });
        } catch (error) {
          writeCommandLog('failed', {
            type: command.type,
            paths,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        writeCommandLog('ignored', { type: command.type, paths });
      }
    }
  })();

  try {
    await commandWork;
  } finally {
    commandWork = null;
  }
};

const startCommandQueue = () => {
  fs.mkdirSync(commandQueueDir(), { recursive: true });
  processQueuedCommands().catch(() => undefined);
  commandTimer = setInterval(() => {
    processQueuedCommands().catch(() => undefined);
  }, 1500);
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
    refreshPairingState()
      .then(() => wakeSyncProcessor())
      .catch(() => wakeSyncProcessor());
    wakeSyncProcessor();
    return ensureState();
  });

  ipcMain.handle('folders:choose', async () => {
    let currentState = ensureState();
    if (currentState.appMode === 'client' && !findDefaultClientVault(currentState)) {
      try {
        currentState = await assignClientVault(currentState);
      } catch (error) {
        notifyCloudError(error instanceof Error ? error.message : 'Nubem storage unavailable');
        return ensureState();
      }
    }

    const clientVault = findDefaultClientVault(currentState);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: clientVault || currentState.appMode === 'client' ? 'Add to Nubem' : 'Choose cloud storage',
      properties: clientVault
        ? ['openFile', 'openDirectory', 'multiSelections']
        : ['openDirectory', 'multiSelections', 'createDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return ensureState();
    }

    if (findDefaultClientVault(ensureState())) {
      return cloudFoldersToDefaultVault(result.filePaths);
    }

    if (ensureState().pairing.role === 'client') {
      notifyCloudError('Nubem storage unavailable');
      return ensureState();
    }

    return (await addVaultsFromPaths(result.filePaths, 'Storage added')).state;
  });

  ipcMain.handle('folders:cloud', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add to Nubem',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
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
      title: 'Remove from Nubem',
      message: `Remove "${folder.name}" from Nubem?`,
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
      'Removed from Nubem'
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
  ipcMain.handle('vaults:rename', (_event, id, name) => renameVault(id, name));
  ipcMain.handle('pairing:refresh', async () => {
    const state = await refreshPairingState();
    wakeSyncProcessor();
    return state;
  });
  ipcMain.handle('pairing:reset', () => resetPairing());
  ipcMain.handle('server:set-mode', (_event, enabled) => setServerMode(Boolean(enabled)));
  ipcMain.handle('remote:browse', (_event, folderId, relativePath) => browseRemoteFolder(folderId, relativePath));
  ipcMain.handle('remote:download', (_event, folderId, relativePath) => downloadRemoteFile(folderId, relativePath));
  ipcMain.handle('remote:delete', (_event, folderId, relativePath) => deleteRemoteEntry(folderId, relativePath));
  ipcMain.handle('remote:share', (_event, folderId, relativePath, type, name) => createShareLink(folderId, relativePath, type, name));
  ipcMain.handle('sync:cancel-job', (_event, jobId) => cancelSyncJob(jobId));
  ipcMain.handle('clipboard:write-text', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('updates:download', () => downloadUpdate());
  ipcMain.handle('updates:install', () => installUpdate());

  heartbeatTimer = setInterval(() => {
    refreshPairingState()
      .then(() => wakeSyncProcessor())
      .catch(() => wakeSyncProcessor());
  }, 5000);

  scheduleUpdateChecks();
  recoverInterruptedSyncJobs();
  startSyncProcessor();
  createWindow();
  startCommandQueue();

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

  if (commandTimer) {
    clearInterval(commandTimer);
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
