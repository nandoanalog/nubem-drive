const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT || 8787);
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const stateFile = path.join(dataDir, 'state.json');
const pairCodeTtlMs = 10 * 60 * 1000;
const onlineWindowMs = 35 * 1000;

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

const readBody = (request) =>
  new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 32_000) {
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
    } else {
      pair.clients[device.id] = device;
    }

    writeState(state);
    return pairPayload(pair);
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
    const result = await handler(await readBody(request));
    if (result?.status) {
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
