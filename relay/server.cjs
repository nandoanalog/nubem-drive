const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT || 8787);
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const stateFile = path.join(dataDir, 'state.json');
const pairCodeTtlMs = 5 * 60 * 1000;
const onlineWindowMs = 35 * 1000;
const requestTtlMs = 60 * 60 * 1000;
const uploadStallMs = 10 * 60 * 1000;
const joinRateWindowMs = 10 * 60 * 1000;
const joinRateLimit = 24;
const defaultBodyLimitBytes = 512 * 1024;
const chunkBodyLimitBytes = 2 * 1024 * 1024;
const pairCodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const now = () => new Date().toISOString();

const readState = () => {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return {
      pairs: state.pairs || {},
      joinAttempts: state.joinAttempts || {},
    };
  } catch {
    return { pairs: {}, joinAttempts: {} };
  }
};

const writeState = (state) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
};

const send = (response, status, payload) => {
  response.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(payload));
};

const readBody = (request, limitBytes = defaultBodyLimitBytes) =>
  new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > limitBytes) {
        reject(new Error('Body too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Bad JSON'));
      }
    });
    request.on('error', reject);
  });

const cleanDevice = (device, role) => ({
  id: String(device?.id || crypto.randomUUID()).slice(0, 80),
  name: String(device?.name || 'Device').slice(0, 80),
  platform: String(device?.platform || 'unknown').slice(0, 32),
  role,
  lastSeenAt: now(),
});

const cleanFolders = (folders) =>
  Array.isArray(folders)
    ? folders.slice(0, 128).map((folder) => ({
        id: String(folder.id || '').slice(0, 80),
        name: String(folder.name || 'Folder').slice(0, 160),
        path: String(folder.path || folder.name || 'Folder').slice(0, 260),
        remotePathPrefix: String(folder.remotePathPrefix || '').slice(0, 260),
        sizeBytes: Number.isFinite(folder.sizeBytes) ? folder.sizeBytes : 0,
        sizeLabel: String(folder.sizeLabel || '').slice(0, 40),
        itemCount: Number.isFinite(folder.itemCount) ? folder.itemCount : 0,
        updatedAt: String(folder.updatedAt || now()),
        status: folder.status || 'synced',
        localMode: folder.localMode || 'online',
        devices: Array.isArray(folder.devices) ? folder.devices.slice(0, 16).map(String) : [],
        progress: Number.isFinite(folder.progress) ? folder.progress : 100,
      }))
    : [];

const ensurePairShape = (pair) => {
  if (!pair || typeof pair !== 'object') return pair;
  pair.clients = pair.clients && typeof pair.clients === 'object' ? pair.clients : {};
  pair.tokens = pair.tokens && typeof pair.tokens === 'object' ? pair.tokens : {};
  pair.requests = pair.requests && typeof pair.requests === 'object' ? pair.requests : {};
  pair.folders = cleanFolders(pair.folders);
  return pair;
};

const prunePairs = (state) => {
  const cutoff = Date.now() - requestTtlMs;
  const uploadCutoff = Date.now() - uploadStallMs;
  const attemptCutoff = Date.now() - joinRateWindowMs;

  for (const pair of Object.values(state.pairs || {})) {
    ensurePairShape(pair);

    for (const [requestId, request] of Object.entries(pair.requests || {})) {
      if (new Date(request.createdAt || 0).getTime() < cutoff) {
        delete pair.requests[requestId];
        fs.rmSync(path.join(dataDir, 'chunks', requestId), { recursive: true, force: true });
        continue;
      }

      const updatedAt = new Date(request.updatedAt || request.createdAt || 0).getTime();
      if (request.status === 'uploading' && updatedAt < uploadCutoff) {
        request.status = 'error';
        request.error = 'Upload interrupted';
        request.updatedAt = now();
        fs.rmSync(path.join(dataDir, 'chunks', requestId), { recursive: true, force: true });
      }
    }
  }

  for (const [key, attempt] of Object.entries(state.joinAttempts || {})) {
    if (new Date(attempt.firstAt || 0).getTime() < attemptCutoff) {
      delete state.joinAttempts[key];
    }
  }

  return state;
};

const normalizePairCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

const formatPairCode = (value) => {
  const code = normalizePairCode(value);
  return code.match(/.{1,4}/g)?.join('-') || code;
};

const isCodeActive = (pair) => !pair.codeExpiresAt || new Date(pair.codeExpiresAt).getTime() > Date.now();

const safePathName = (value, fallback = 'Vault') => {
  const clean = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return clean || fallback;
};

const makeCode = (state) => {
  for (let index = 0; index < 20; index += 1) {
    let code = '';
    for (let charIndex = 0; charIndex < 12; charIndex += 1) {
      code += pairCodeAlphabet[crypto.randomInt(0, pairCodeAlphabet.length)];
    }

    const exists = Object.values(state.pairs).some((pair) => pair.code === code && isCodeActive(pair));
    if (!exists) return code;
  }

  let fallback = '';
  while (fallback.length < 12) {
    fallback += pairCodeAlphabet[crypto.randomInt(0, pairCodeAlphabet.length)];
  }
  return fallback;
};

const clientKey = (request) => {
  const forwardedFor = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const rawAddress = forwardedFor || request.socket.remoteAddress || 'unknown';
  return crypto.createHash('sha256').update(rawAddress).digest('hex').slice(0, 24);
};

const joinAttempt = (state, request) => {
  state.joinAttempts = state.joinAttempts || {};
  const key = clientKey(request);
  const existing = state.joinAttempts[key];
  const firstAt = existing?.firstAt && Date.now() - new Date(existing.firstAt).getTime() < joinRateWindowMs ? existing.firstAt : now();
  const count = existing?.firstAt === firstAt ? Number(existing.count || 0) + 1 : 1;

  state.joinAttempts[key] = { firstAt, count };
  return state.joinAttempts[key];
};

const joinAllowed = (state, request) => {
  const attempt = state.joinAttempts?.[clientKey(request)];
  if (!attempt) return true;

  const inWindow = Date.now() - new Date(attempt.firstAt || 0).getTime() < joinRateWindowMs;
  return !inWindow || Number(attempt.count || 0) < joinRateLimit;
};

const publicDevices = (pair) => {
  const devices = [pair.storage, ...Object.values(pair.clients || {})].filter(Boolean);
  return devices.map((device) => {
    const age = Date.now() - new Date(device.lastSeenAt || 0).getTime();
    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      role: device.role,
      status: age < onlineWindowMs ? 'online' : 'sleeping',
      lastSeenAt: device.lastSeenAt,
    };
  });
};

const pairPayload = (pair, extra = {}) => ({
  ok: true,
  pairId: pair.id,
  code: pair.code ? formatPairCode(pair.code) : '',
  expiresAt: pair.codeExpiresAt,
  vault: pair.vault || null,
  storageName: pair.storage?.name,
  devices: publicDevices(pair),
  folders: pairFoldersForToken(pair, extra.token),
  clientVaults: pairClientVaultsForToken(pair, extra.token),
  ...extra,
});

const pairFoldersForToken = (pair, token) => {
  const folders = cleanFolders(pair.folders);
  const deviceId = token ? tokenDeviceId(pair, token) : '';
  const client = deviceId ? pair.clients?.[deviceId] : null;
  if (!client || folders.length === 0) return folders;

  const rootFolder = folders[0];
  const remotePathPrefix = safePathName(client.remotePathPrefix || client.name || 'Client');
  return [{
    ...rootFolder,
    name: client.vaultName || 'My Vault',
    path: remotePathPrefix,
    remotePathPrefix,
    devices: [pair.storage?.name || 'Storage PC'],
  }];
};

const pairClientVaultsForToken = (pair, token) => {
  if (tokenRole(pair, token) !== 'storage') return [];

  const byPrefix = new Map();
  for (const client of Object.values(pair.clients || {})) {
    const age = Date.now() - new Date(client.lastSeenAt || 0).getTime();
    const remotePathPrefix = safePathName(client.remotePathPrefix || client.name || 'Client', 'Client');
    const vault = {
      id: client.id,
      name: safePathName(client.vaultName || 'My Vault', 'My Vault'),
      clientName: client.name || 'Client',
      remotePathPrefix,
      status: age < onlineWindowMs ? 'online' : 'sleeping',
      lastSeenAt: client.lastSeenAt || '',
    };
    const existing = byPrefix.get(remotePathPrefix);
    const existingSeen = new Date(existing?.lastSeenAt || 0).getTime();
    const nextSeen = new Date(vault.lastSeenAt || 0).getTime();

    if (!existing || nextSeen >= existingSeen) {
      byPrefix.set(remotePathPrefix, vault);
    }
  }

  return Array.from(byPrefix.values());
};

const findPairByCode = (state, code) =>
  Object.values(state.pairs).map(ensurePairShape).find((pair) => pair.code === code && isCodeActive(pair));

const verifyPair = (state, pairId, token) => {
  const pair = ensurePairShape(state.pairs[pairId]);
  if (!pair || !token || !pair.tokens?.[token]) {
    return null;
  }

  return pair;
};

const tokenDeviceId = (pair, token) => pair.tokens?.[token];

const tokenRole = (pair, token) => {
  const deviceId = tokenDeviceId(pair, token);
  if (!deviceId) return null;
  return deviceId === pair.storage?.id ? 'storage' : 'client';
};

const availableStoragePairs = (state) =>
  Object.values(state.pairs || {})
    .filter((pair) => {
      if (!pair.storage || cleanFolders(pair.folders).length === 0) return false;
      return Date.now() - new Date(pair.storage.lastSeenAt || 0).getTime() < onlineWindowMs;
    })
    .sort((left, right) => new Date(right.storage?.lastSeenAt || right.createdAt || 0).getTime() - new Date(left.storage?.lastSeenAt || left.createdAt || 0).getTime());

const verifyStorage = (state, pairId, token) => {
  const pair = verifyPair(state, pairId, token);
  if (!pair || tokenRole(pair, token) !== 'storage') return null;
  return pair;
};

const publicRequest = (request) => ({
  id: request.id,
  type: request.type,
  folderId: request.folderId,
  relativePath: request.relativePath,
  fileName: request.fileName,
  totalBytes: request.totalBytes,
  sizeLabel: request.sizeLabel,
  chunkCount: request.chunkCount,
  modifiedAt: request.modifiedAt,
  requesterId: request.requesterId,
  createdAt: request.createdAt,
});

const chunkDir = (requestId) => path.join(dataDir, 'chunks', requestId);

const chunkPath = (requestId, index) => path.join(chunkDir(requestId), `${index}.b64`);

const requestResult = (request) => ({
  ok: true,
  status: request.status,
  requestId: request.id,
  result: request.result || null,
  error: request.error || '',
});

const handlers = {
  'POST /api/drive/vaults/create': async (body) => {
    const state = readState();
    const pairId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    const code = makeCode(state);
    const storage = cleanDevice(body.device, 'storage');
    const folders = cleanFolders([body.folder || {}]);
    const folder = folders[0] || {
      id: crypto.randomUUID(),
      name: 'Vault',
      path: 'Vault',
      sizeLabel: 'Cloud',
      itemCount: 0,
      updatedAt: now(),
      status: 'synced',
      localMode: 'online',
      devices: [],
      progress: 100,
    };

    state.pairs[pairId] = {
      id: pairId,
      code,
      codeExpiresAt: '',
      createdAt: now(),
      vault: {
        id: folder.id,
        name: folder.name,
      },
      storage,
      clients: {},
      folders: [folder],
      requests: {},
      tokens: {
        [token]: storage.id,
      },
    };

    writeState(state);
    return pairPayload(state.pairs[pairId], { token });
  },

  'POST /api/drive/vaults/join': async (body, request) => {
    const code = normalizePairCode(body.code);
    const state = readState();

    if (!joinAllowed(state, request)) {
      return { status: 429, payload: { ok: false, error: 'Too many attempts. Try later.' } };
    }

    const pair = findPairByCode(state, code);

    if (!pair) {
      joinAttempt(state, request);
      writeState(prunePairs(state));
      return { status: 404, payload: { ok: false, error: 'Code expired or wrong' } };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const client = cleanDevice(body.device, 'client');
    pair.clients[client.id] = client;
    pair.tokens[token] = client.id;
    writeState(state);

    return pairPayload(pair, { token });
  },

  'POST /api/drive/vaults/assign': async (body) => {
    const state = prunePairs(readState());
    const pair = availableStoragePairs(state)[0];

    if (!pair) {
      writeState(state);
      return { status: 503, payload: { ok: false, error: 'No storage available' } };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const client = {
      ...cleanDevice(body.device, 'client'),
      vaultName: safePathName(body.vaultName || 'My Vault', 'My Vault'),
    };
    const taken = new Set(Object.values(pair.clients || {}).map((device) => safePathName(device.remotePathPrefix || device.name || 'Client')));
    const basePrefix = safePathName(client.name || client.id, 'Client');
    let remotePathPrefix = basePrefix;
    let suffix = 2;
    while (taken.has(remotePathPrefix)) {
      remotePathPrefix = `${basePrefix} ${suffix}`;
      suffix += 1;
    }

    client.remotePathPrefix = remotePathPrefix;
    pair.clients[client.id] = client;
    pair.tokens[token] = client.id;

    writeState(state);
    return pairPayload(pair, { token });
  },

  'POST /api/drive/pair-codes': async (body) => {
    const state = readState();
    const pairId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    const code = makeCode(state);
    const storage = cleanDevice(body.device, 'storage');

    state.pairs[pairId] = {
      id: pairId,
      code,
      codeExpiresAt: new Date(Date.now() + pairCodeTtlMs).toISOString(),
      createdAt: now(),
      storage,
      clients: {},
      folders: cleanFolders(body.folders),
      requests: {},
      tokens: {
        [token]: storage.id,
      },
    };

    writeState(state);
    return pairPayload(state.pairs[pairId], { token });
  },

  'POST /api/drive/join': async (body, request) => {
    const code = normalizePairCode(body.code);
    const state = readState();

    if (!joinAllowed(state, request)) {
      return { status: 429, payload: { ok: false, error: 'Too many attempts. Try later.' } };
    }

    const pair = findPairByCode(state, code);

    if (!pair) {
      joinAttempt(state, request);
      writeState(prunePairs(state));
      return { status: 404, payload: { ok: false, error: 'Code expired or wrong' } };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const client = cleanDevice(body.device, 'client');
    pair.clients[client.id] = client;
    pair.tokens[token] = client.id;
    pair.code = '';
    pair.codeExpiresAt = now();
    writeState(state);

    return pairPayload(pair, { token });
  },

  'POST /api/drive/heartbeat': async (body) => {
    const state = readState();
    const pair = verifyPair(state, body.pairId, body.token);

    if (!pair) {
      return { status: 401, payload: { ok: false, error: 'Not linked' } };
    }

    const deviceId = pair.tokens[body.token];
    const role = deviceId === pair.storage.id ? 'storage' : 'client';
    const device = cleanDevice({ ...body.device, id: deviceId }, role);

    if (role === 'storage') {
      pair.storage = device;
      pair.folders = cleanFolders(body.folders);
    } else {
      pair.clients[device.id] = device;
    }

    prunePairs(state);
    writeState(state);
    return pairPayload(pair, { token: body.token });
  },

  'POST /api/drive/requests/create': async (body) => {
    const state = readState();
    const pair = verifyPair(state, body.pairId, body.token);

    if (!pair) {
      return { status: 401, payload: { ok: false, error: 'Not linked' } };
    }

    const allowedTypes = new Set(['delete', 'download', 'list', 'stat', 'upload']);
    const type = allowedTypes.has(body.type) ? body.type : 'list';
    const requestId = crypto.randomUUID();
    const request = {
      id: requestId,
      type,
      folderId: String(body.folderId || '').slice(0, 80),
      relativePath: String(body.relativePath || '').slice(0, 2000),
      fileName: String(body.fileName || '').slice(0, 260),
      totalBytes: Number.isFinite(body.totalBytes) ? body.totalBytes : 0,
      sizeLabel: String(body.sizeLabel || '').slice(0, 40),
      chunkCount: Number.isFinite(body.chunkCount) ? body.chunkCount : 0,
      modifiedAt: String(body.modifiedAt || '').slice(0, 64),
      requesterId: tokenDeviceId(pair, body.token),
      status: type === 'upload' ? 'uploading' : 'pending',
      createdAt: now(),
      updatedAt: now(),
    };

    pair.requests = pair.requests || {};
    pair.requests[requestId] = request;
    writeState(prunePairs(state));

    return { ok: true, requestId };
  },

  'POST /api/drive/requests/upload-ready': async (body) => {
    const state = readState();
    const pair = verifyPair(state, body.pairId, body.token);

    if (!pair) {
      return { status: 401, payload: { ok: false, error: 'Not linked' } };
    }

    const request = pair.requests?.[body.requestId];
    if (!request || request.type !== 'upload') {
      return { status: 404, payload: { ok: false, error: 'Request expired' } };
    }

    if (request.requesterId !== tokenDeviceId(pair, body.token)) {
      return { status: 403, payload: { ok: false, error: 'Not your request' } };
    }

    for (let index = 0; index < Number(request.chunkCount || 0); index += 1) {
      if (!fs.existsSync(chunkPath(request.id, index))) {
        request.status = 'error';
        request.error = 'Upload incomplete';
        request.updatedAt = now();
        writeState(state);
        return { status: 400, payload: { ok: false, error: 'Upload incomplete' } };
      }
    }

    request.status = 'pending';
    request.updatedAt = now();
    writeState(state);

    return { ok: true };
  },

  'POST /api/drive/requests/fail': async (body) => {
    const state = readState();
    const pair = verifyPair(state, body.pairId, body.token);

    if (!pair) {
      return { status: 401, payload: { ok: false, error: 'Not linked' } };
    }

    const request = pair.requests?.[body.requestId];
    if (!request || request.type !== 'upload') {
      return { status: 404, payload: { ok: false, error: 'Request expired' } };
    }

    if (request.requesterId !== tokenDeviceId(pair, body.token)) {
      return { status: 403, payload: { ok: false, error: 'Not your request' } };
    }

    request.status = 'error';
    request.error = String(body.error || 'Upload failed').slice(0, 500);
    request.updatedAt = now();
    fs.rmSync(chunkDir(request.id), { recursive: true, force: true });
    writeState(state);

    return { ok: true };
  },

  'POST /api/drive/requests/poll': async (body) => {
    const state = readState();
    const pair = verifyStorage(state, body.pairId, body.token);

    if (!pair) {
      return { status: 401, payload: { ok: false, error: 'Storage token required' } };
    }

    const requests = Object.values(pair.requests || {})
      .filter((request) => request.status === 'pending')
      .slice(0, 8)
      .map(publicRequest);

    return { ok: true, requests };
  },

  'POST /api/drive/requests/complete': async (body) => {
    const state = readState();
    const pair = verifyStorage(state, body.pairId, body.token);

    if (!pair) {
      return { status: 401, payload: { ok: false, error: 'Storage token required' } };
    }

    const request = pair.requests?.[body.requestId];
    if (!request) {
      return { status: 404, payload: { ok: false, error: 'Request expired' } };
    }

    request.status = body.error ? 'error' : 'ready';
    request.error = body.error ? String(body.error).slice(0, 500) : '';
    request.result = body.result || null;
    request.updatedAt = now();
    if (body.error) {
      fs.rmSync(chunkDir(request.id), { recursive: true, force: true });
    }
    writeState(state);

    return { ok: true };
  },

  'POST /api/drive/requests/result': async (body) => {
    const state = readState();
    const pair = verifyPair(state, body.pairId, body.token);

    if (!pair) {
      return { status: 401, payload: { ok: false, error: 'Not linked' } };
    }

    const request = pair.requests?.[body.requestId];
    if (!request) {
      return { status: 404, payload: { ok: false, error: 'Request expired' } };
    }

    const requesterId = tokenDeviceId(pair, body.token);
    if (request.requesterId !== requesterId && tokenRole(pair, body.token) !== 'storage') {
      return { status: 403, payload: { ok: false, error: 'Not your request' } };
    }

    return requestResult(request);
  },

  'POST /api/drive/requests/chunk': async (body) => {
    const state = readState();
    const pair = verifyPair(state, body.pairId, body.token);

    if (!pair) {
      return { status: 401, payload: { ok: false, error: 'Not linked' } };
    }

    const request = pair.requests?.[body.requestId];
    if (!request || !['download', 'upload'].includes(request.type)) {
      return { status: 404, payload: { ok: false, error: 'Request expired' } };
    }

    if (Object.prototype.hasOwnProperty.call(body, 'data')) {
      const requesterId = tokenDeviceId(pair, body.token);
      const canWriteDownloadChunk = request.type === 'download' && tokenRole(pair, body.token) === 'storage';
      const canWriteUploadChunk = request.type === 'upload' && request.requesterId === requesterId;

      if (!canWriteDownloadChunk && !canWriteUploadChunk) {
        return { status: 401, payload: { ok: false, error: 'Storage token required' } };
      }

      fs.mkdirSync(chunkDir(request.id), { recursive: true });
      fs.writeFileSync(chunkPath(request.id, Number(body.index || 0)), String(body.data));
      request.updatedAt = now();
      writeState(state);
      return { ok: true };
    }

    const requesterId = tokenDeviceId(pair, body.token);
    if (request.requesterId !== requesterId && tokenRole(pair, body.token) !== 'storage') {
      return { status: 403, payload: { ok: false, error: 'Not your request' } };
    }

    const file = chunkPath(request.id, Number(body.index || 0));
    if (!fs.existsSync(file)) {
      return { status: 404, payload: { ok: false, error: 'Chunk missing' } };
    }

    return { ok: true, data: fs.readFileSync(file, 'utf8') };
  },
};

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    send(response, 204, {});
    return;
  }

  if (request.method === 'GET' && request.url === '/api/drive/health') {
    send(response, 200, { ok: true, at: now() });
    return;
  }

  const route = `${request.method} ${request.url}`;
  const handler = handlers[route];

  if (!handler) {
    send(response, 404, { ok: false, error: 'Not found' });
    return;
  }

  try {
    const result = await handler(
      await readBody(request, route === 'POST /api/drive/requests/chunk' ? chunkBodyLimitBytes : defaultBodyLimitBytes),
      request
    );
    if (Number.isInteger(result?.status)) {
      send(response, result.status, result.payload);
      return;
    }

    send(response, 200, result);
  } catch (error) {
    send(response, 500, { ok: false, error: error instanceof Error ? error.message : 'Server error' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Nubem Drive relay listening on ${port}`);
});
