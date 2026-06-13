const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stateFile = process.env.NUBEM_DRIVE_STATE_FILE || path.join(os.homedir(), '.config', 'nubem-drive', 'state.json');

const now = () => new Date().toISOString();

const initialState = () => ({
  storageNode: {
    name: `${os.hostname()} storage`,
    path: path.join(os.homedir(), 'Nubem Storage'),
    capacityBytes: 2_000_000_000_000,
    usedBytes: 612_000_000_000,
    status: 'online',
    relayStatus: 'ready',
  },
  currentDevice: {
    name: os.hostname(),
    platform: process.platform,
    status: 'online',
  },
  folders: [],
  activity: [],
  devices: [
    { id: crypto.randomUUID(), name: os.hostname(), role: 'Storage node', status: 'online', address: 'LAN' },
  ],
});

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return initialState();
  }
};

const notify = (title, body) => {
  const child = spawn('notify-send', [title, body], {
    detached: true,
    stdio: 'ignore',
  });

  child.on('error', () => {});
  child.unref();
};

const makeFolder = (folderPath) => ({
  id: crypto.randomUUID(),
  name: path.basename(folderPath) || folderPath,
  path: folderPath,
  sizeLabel: 'Scanning',
  itemCount: 0,
  updatedAt: now(),
  status: 'queued',
  localMode: 'mirror',
  devices: ['This PC'],
  progress: 0,
});

const rawPaths = process.argv.slice(2);
const folders = rawPaths
  .map((item) => path.resolve(item))
  .filter((item) => {
    try {
      return fs.statSync(item).isDirectory();
    } catch {
      return false;
    }
  });

if (folders.length === 0) {
  notify('Nubem Drive', 'No folder selected');
  process.exit(1);
}

const state = readState();
const knownPaths = new Set(state.folders.map((folder) => folder.path));
const nextFolders = folders.filter((folderPath) => !knownPaths.has(folderPath)).map(makeFolder);

if (nextFolders.length === 0) {
  notify('Nubem Drive', 'Folder already clouded');
  process.exit(0);
}

const nextState = {
  ...state,
  folders: [...nextFolders, ...state.folders],
  activity: [
    {
      id: crypto.randomUUID(),
      type: 'upload',
      label: nextFolders.length === 1 ? nextFolders[0].name : `${nextFolders.length} folders`,
      detail: 'Queued from context menu',
      at: now(),
    },
    ...state.activity,
  ].slice(0, 16),
};

fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify(nextState, null, 2));

notify('Nubem Drive', nextFolders.length === 1 ? `${nextFolders[0].name} clouded` : `${nextFolders.length} folders clouded`);
