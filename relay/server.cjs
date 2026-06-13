const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT || 8787);
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const stateFile = path.join(dataDir, 'state.json');
const pairCodeTtlMs = 10 * 60 * 1000;
const onlineWindowMs = 35 * 1000;
const requestTtlMs = 60 * 60 * 1000;
const defaultBodyLimitBytes = 512 * 1024;
const chunkBodyLimitBytes = 2 * 1024 * 1024;

const now = () => new Date().toISOString();

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { pairs: {} };
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
        sizeLabel: String(folder.sizeLabel || '').slice(0, 40),
        itemCount: Number.isFinite(folder.itemCount) ? folder.itemCount : 0,
        updatedAt: String(folder.updatedAt || now()),
        status: folder.status || 'synced',
        localMode: folder.localMode || 'online',
        devices: Array.isArray(folder.devices) ? folder.devices.slice(0, 16).map(String) : [],
        progress: Number.isFinite(folder.progress) ? folder.progress : 100,
      }))
    : [];

const prunePairs = (state) => {
  const cutoff = Date.now() - requestTtlMs;
  for (const pair of Object.values(state.pairs || {})) {
    for (const [requestId, request] of Object.entries(pair.requests || {})) {
      if (new Date(request.createdAt || 0).getTime() < cutoff) {
        delete pair.requests[requestId];
        fs.rmSync(path.join(dataDir, 'chunks', requestId), { recursive: true, force: true });
      }
    }
  }

  return state;
};

const makeCode = (state) => {
  for (let index = 0; index < 20; index += 1) {
    const code = String(crypto.randomInt(100000, 999999));
    const exists = Object.values(state.pairs).some(
      (pair) => pair.code === code && new Date(pair.codeExpiresAt).getTime() > Date.now()
    );
    if (!exists) return code;
  }

  return String(crypto.randomInt(100000, 999999));
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
  code: pair.code,
  expiresAt: pair.codeExpiresAt,
  storageName: pair.storage?.name,
  devices: publicDevices(pair),
  folders: cleanFolders(pair.folders),
  ...extra,
});

const findPairByCode = (state, code) =>
  Object.values(state.pairs).find(
    (pair) => pair.code === code && new Date(pair.codeExpiresAt).getTime() > Date.now()
  );

const verifyPair = (state, pairId, token) => {
  const pair = state.pairs[pairId];
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

  'POST /api/drive/join': async (body) => {
    const code = String(body.code || '').replace(/\D/g, '');
    const state = readState();
    const pair = findPairByCode(state, code);

    if (!pair) {
      return { status: 404, payload: { ok: false, error: 'Code expired' } };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const client = cleanDevice(body.device, 'client');
    pair.clients[client.id] = client;
    pair.tokens[token] = client.id;
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
    return pairPayload(pair);
  },

  'POST /api/drive/requests/create': async (body) => {
    const state = readState();
    const pair = verifyPair(state, body.pairId, body.token);

    if (!pair) {
      return { status: 401, payload: { ok: false, error: 'Not linked' } };
    }

    const type = body.type === 'download' ? 'download' : 'list';
    const requestId = crypto.randomUUID();
    const request = {
      id: requestId,
      type,
      folderId: String(body.folderId || '').slice(0, 80),
      relativePath: String(body.relativePath || '').slice(0, 2000),
      requesterId: tokenDeviceId(pair, body.token),
      status: 'pending',
      createdAt: now(),
      updatedAt: now(),
    };

    pair.requests = pair.requests || {};
    pair.requests[requestId] = request;
    writeState(prunePairs(state));

    return { ok: true, requestId };
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
    if (!request || request.type !== 'download') {
      return { status: 404, payload: { ok: false, error: 'Request expired' } };
    }

    if (body.data) {
      if (tokenRole(pair, body.token) !== 'storage') {
        return { status: 401, payload: { ok: false, error: 'Storage token required' } };
      }

      fs.mkdirSync(chunkDir(request.id), { recursive: true });
      fs.writeFileSync(chunkPath(request.id, Number(body.index || 0)), String(body.data));
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
      await readBody(request, route === 'POST /api/drive/requests/chunk' ? chunkBodyLimitBytes : defaultBodyLimitBytes)
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
