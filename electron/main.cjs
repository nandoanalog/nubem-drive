const { app, BrowserWindow, Notification, dialog, ipcMain, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isDev = !app.isPackaged;
let mainWindow;
let heartbeatTimer;

const dataFile = () => path.join(app.getPath('userData'), 'state.json');
const defaultRelayUrl = 'https://drive.nubem.org';

const now = () => new Date().toISOString();

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

const relayStatusFromPairing = (pairing) => {
  if (pairing?.status === 'linked') return 'linked';
  if (pairing?.status === 'waiting') return 'waiting';
  if (pairing?.status === 'error') return 'limited';
  if (pairing?.status === 'ready') return 'ready';
  return 'offline';
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
  };

  pairing.relayUrl = normalizeRelayUrl(pairing.relayUrl);

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
    folders: Array.isArray(state.folders) ? state.folders : [],
    activity: Array.isArray(state.activity) ? state.activity : [],
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
    const state = normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
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
  const timeout = setTimeout(() => controller.abort(), 8000);

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

const applyRelaySnapshot = (state, payload, status = 'linked') => {
  const devices = Array.isArray(payload.devices)
    ? payload.devices.map((device) => mapRelayDevice(device, state.currentDevice.id))
    : state.devices;
  const hasOtherDevice = devices.some((device) => device.id !== state.currentDevice.id);
  const nextStatus = status === 'waiting' && hasOtherDevice ? 'linked' : status;
  const nextPairing = {
    ...state.pairing,
    status: nextStatus,
    message: '',
    lastSeenAt: now(),
    storageName: payload.storageName || state.pairing.storageName,
  };

  if (payload.pairCodeExpiresAt && new Date(payload.pairCodeExpiresAt).getTime() <= Date.now()) {
    delete nextPairing.pairCode;
    delete nextPairing.pairCodeExpiresAt;
  }

  return writeState({
    ...state,
    pairing: nextPairing,
    devices,
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

const refreshPairingState = async () => {
  const state = ensureState();
  if (!state.pairing.pairId || !state.pairing.token) {
    return state;
  }

  try {
    const payload = await relayRequest(state.pairing.relayUrl, '/api/drive/heartbeat', {
      pairId: state.pairing.pairId,
      token: state.pairing.token,
      device: localRelayDevice(state),
    });
    return applyRelaySnapshot(state, payload, state.pairing.role === 'storage' ? 'waiting' : 'linked');
  } catch (error) {
    return markRelayError(state, error instanceof Error ? error.message : 'Relay offline');
  }
};

const createPairCode = async (relayUrl) => {
  const state = ensureState();
  const nextRelayUrl = normalizeRelayUrl(relayUrl);
  const payload = await relayRequest(nextRelayUrl, '/api/drive/pair-codes', {
    device: localRelayDevice(state, 'storage'),
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
  const cleanCode = String(code || '').replace(/\D/g, '');
  if (cleanCode.length !== 6) {
    throw new Error('Use the 6 digit code');
  }

  const nextRelayUrl = normalizeRelayUrl(relayUrl);
  const payload = await relayRequest(nextRelayUrl, '/api/drive/join', {
    code: cleanCode,
    device: localRelayDevice(state, 'client'),
  });
  const nextState = addActivity(
    {
      ...state,
      pairing: {
        relayUrl: nextRelayUrl,
        role: 'client',
        status: 'linked',
        pairId: payload.pairId,
        token: payload.token,
        storageName: payload.storageName,
        message: '',
      },
    },
    'link',
    'Linked',
    payload.storageName || 'Storage PC'
  );

  return applyRelaySnapshot(writeState(nextState), payload, 'linked');
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

const cloudFoldersAndNotify = (folderPaths) => {
  const { added } = addFoldersFromPaths(folderPaths, 'Queued from context menu');
  if (added.length > 0) {
    notifyClouded(added);
  }

  return added;
};

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const cloudFolderArgs = getCloudFolderArgs(argv);

    app.whenReady().then(() => {
      if (cloudFolderArgs.length > 0) {
        cloudFoldersAndNotify(cloudFolderArgs);
        return;
      }

      focusMainWindow();
    });
  });
}

app.whenReady().then(() => {
  if (!singleInstanceLock) {
    return;
  }

  const cloudFolderArgs = getCloudFolderArgs();
  if (cloudFolderArgs.length > 0) {
    cloudFoldersAndNotify(cloudFolderArgs);
    setTimeout(() => app.quit(), 600);
    return;
  }

  ipcMain.handle('app:get-state', () => {
    refreshPairingState().catch(() => undefined);
    return ensureState();
  });

  ipcMain.handle('folders:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add folder',
      properties: ['openDirectory', 'multiSelections', 'createDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return ensureState();
    }

    return addFoldersFromPaths(result.filePaths).state;
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
  ipcMain.handle('pairing:refresh', () => refreshPairingState());
  ipcMain.handle('pairing:reset', () => resetPairing());

  heartbeatTimer = setInterval(() => {
    refreshPairingState().catch(() => undefined);
  }, 5000);

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

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
