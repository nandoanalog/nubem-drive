const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT || 8787);
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const stateFile = path.join(dataDir, 'state.json');
const pairCodeTtlMs = 5 * 60 * 1000;
const onlineWindowMs = 35 * 1000;
const requestTtlMs = 24 * 60 * 60 * 1000;
const uploadStallMs = 10 * 60 * 1000;
const shareTtlMs = 24 * 60 * 60 * 1000;
const shareMaxDownloads = 3;
const publicRequestTimeoutMs = 15 * 60 * 1000;
const joinRateWindowMs = 10 * 60 * 1000;
const joinRateLimit = 24;
const defaultBodyLimitBytes = 512 * 1024;
const chunkBodyLimitBytes = 8 * 1024 * 1024;
const pairCodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const now = () => new Date().toISOString();

const readState = () => {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return {
      pairs: state.pairs || {},
      joinAttempts: state.joinAttempts || {},
      shares: state.shares || {},
    };
  } catch {
    return { pairs: {}, joinAttempts: {}, shares: {} };
  }
};

const writeState = (state) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const temp = `${stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, stateFile);
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

const sendHtml = (response, status, html) => {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(html);
};

const sendPublicMessage = (response, status, title, detail = '') => {
  sendHtml(response, status, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f1ea;color:#171a1d}
    main{display:grid;min-height:100vh;place-items:center;padding:24px}
    section{width:min(520px,100%);border:1px solid #ded8ce;border-radius:8px;background:#fffdf8;padding:22px}
    h1{margin:0 0 8px;font-size:20px;letter-spacing:0}
    p{margin:0;color:#68716d;font-weight:700;line-height:1.45}
  </style>
</head>
<body><main><section><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></section></main></body>
</html>`);
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

const cancelDuplicateUploads = (pair, nextRequest) => {
  if (nextRequest.type !== 'upload') return;

  for (const request of Object.values(pair.requests || {})) {
    if (
      request.id !== nextRequest.id &&
      request.type === 'upload' &&
      request.requesterId === nextRequest.requesterId &&
      request.relativePath === nextRequest.relativePath &&
      request.status === 'uploading'
    ) {
      request.status = 'error';
      request.error = 'Replaced by a newer upload';
      request.updatedAt = now();
      fs.rmSync(chunkDir(request.id), { recursive: true, force: true });
    }
  }
};

const prunePairs = (state) => {
  const cutoff = Date.now() - requestTtlMs;
  const uploadCutoff = Date.now() - uploadStallMs;
  const attemptCutoff = Date.now() - joinRateWindowMs;

  state.shares = state.shares && typeof state.shares === 'object' ? state.shares : {};

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

  for (const [token, share] of Object.entries(state.shares || {})) {
    const expiresAt = new Date(share.expiresAt || 0).getTime();
    const maxDownloads = Number(share.maxDownloads || shareMaxDownloads);
    const downloadCount = Number(share.downloadCount || 0);
    if (
      share.revokedAt ||
      !state.pairs?.[share.pairId] ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      downloadCount >= maxDownloads
    ) {
      delete state.shares[token];
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

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const normalizeRemotePath = (value = '') => {
  const raw = String(value || '').replace(/\\/g, '/');
  const parts = raw.split('/').filter(Boolean);

  if (
    raw.startsWith('/') ||
    /^[A-Za-z]:/.test(raw) ||
    raw.includes('\0') ||
    parts.some((part) => part === '..')
  ) {
    throw new Error('Invalid path');
  }

  return parts.join('/');
};

const joinRemotePath = (...parts) =>
  parts
    .map((part) => normalizeRemotePath(part))
    .filter(Boolean)
    .join('/');

const stripPathPrefix = (prefix, relativePath) => {
  const cleanPrefix = normalizeRemotePath(prefix);
  const cleanPath = normalizeRemotePath(relativePath);
  if (!cleanPrefix) return cleanPath;
  if (cleanPath === cleanPrefix) return '';
  return cleanPath.startsWith(`${cleanPrefix}/`) ? cleanPath.slice(cleanPrefix.length + 1) : cleanPath;
};

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

const publicBaseUrl = (request) => {
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0].trim();
  const protoHeader = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = protoHeader || (host.startsWith('127.') || host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host || `127.0.0.1:${port}`}`;
};

const canSharePathForToken = (pair, token, relativePath) => {
  const role = tokenRole(pair, token);
  if (role === 'storage') return true;
  if (role !== 'client') return false;

  const deviceId = tokenDeviceId(pair, token);
  const client = pair.clients?.[deviceId];
  if (!client) return false;

  const prefix = normalizeRemotePath(safePathName(client.remotePathPrefix || client.name || 'Client', 'Client'));
  const cleanPath = normalizeRemotePath(relativePath);
  return cleanPath === prefix || cleanPath.startsWith(`${prefix}/`);
};

const publicSharePayload = (share, request) => ({
  ok: true,
  token: share.token,
  url: `${publicBaseUrl(request)}/s/${share.token}`,
  name: share.name,
  type: share.type,
  relativePath: share.relativePath,
  expiresAt: share.expiresAt,
  maxDownloads: Number(share.maxDownloads || shareMaxDownloads),
  downloadCount: Number(share.downloadCount || 0),
});

const createPublicRequest = (state, share, type, relativePath) => {
  const requestId = crypto.randomUUID();
  const pair = ensurePairShape(state.pairs?.[share.pairId]);
  if (!pair) {
    throw new Error('Share unavailable');
  }

  pair.requests = pair.requests || {};
  pair.requests[requestId] = {
    id: requestId,
    type,
    folderId: share.folderId,
    relativePath,
    fileName: '',
    totalBytes: 0,
    sizeLabel: '',
    chunkCount: 0,
    modifiedAt: '',
    requesterId: `share:${share.token}`,
    status: 'pending',
    createdAt: now(),
    updatedAt: now(),
  };

  writeState(prunePairs(state));
  return requestId;
};

const waitForPublicRequest = async (pairId, requestId, timeoutMs = publicRequestTimeoutMs) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const state = readState();
    const pair = ensurePairShape(state.pairs?.[pairId]);
    const request = pair?.requests?.[requestId];

    if (!request) {
      throw new Error('Request expired');
    }

    if (request.status === 'ready') {
      return { state, pair, request };
    }

    if (request.status === 'error') {
      throw new Error(request.error || 'Storage request failed');
    }

    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  throw new Error('Storage PC did not respond');
};

const cleanupPublicRequest = (pairId, requestId) => {
  const state = readState();
  const pair = ensurePairShape(state.pairs?.[pairId]);
  if (pair?.requests?.[requestId]) {
    delete pair.requests[requestId];
  }
  fs.rmSync(chunkDir(requestId), { recursive: true, force: true });
  writeState(prunePairs(state));
};

const incrementShareDownload = (token) => {
  const state = readState();
  const share = state.shares?.[token];
  if (!share) return;

  share.downloadCount = Number(share.downloadCount || 0) + 1;
  share.lastDownloadedAt = now();
  if (share.downloadCount >= Number(share.maxDownloads || shareMaxDownloads)) {
    share.revokedAt = now();
  }

  writeState(prunePairs(state));
};

const shareFromRequest = (token) => {
  const state = prunePairs(readState());
  const share = state.shares?.[token];
  const pair = share ? ensurePairShape(state.pairs?.[share.pairId]) : null;

  if (!share || !pair) {
    return { error: 'This link is expired or unavailable' };
  }

  if (Number(share.downloadCount || 0) >= Number(share.maxDownloads || shareMaxDownloads)) {
    delete state.shares[token];
    writeState(state);
    return { error: 'This link has reached its download limit' };
  }

  return { state, share, pair };
};

const publicChildPath = (share, childPath = '') => joinRemotePath(share.relativePath, childPath);

const filenameHeader = (fileName) => {
  const fallback = safePathName(fileName || 'download', 'download').replace(/"/g, '');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName || fallback)}`;
};

const sendSharedFile = async (request, response, share, pair, childPath = '') => {
  const relativePath = share.type === 'file' ? share.relativePath : publicChildPath(share, childPath);
  const requestId = createPublicRequest(readState(), share, 'download', relativePath);

  try {
    const startedAt = Date.now();
    let headersSent = false;
    let nextChunk = 0;

    while (Date.now() - startedAt < publicRequestTimeoutMs) {
      const state = readState();
      const currentPair = ensurePairShape(state.pairs?.[share.pairId]);
      const currentRequest = currentPair?.requests?.[requestId];

      if (!currentRequest) {
        throw new Error('Request expired');
      }

      if (currentRequest.status === 'error') {
        throw new Error(currentRequest.error || 'Storage request failed');
      }

      while (fs.existsSync(chunkPath(requestId, nextChunk))) {
        if (!headersSent) {
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': filenameHeader(share.name || 'download'),
            'cache-control': 'no-store',
          });
          headersSent = true;
        }

        const ready = response.write(Buffer.from(fs.readFileSync(chunkPath(requestId, nextChunk), 'utf8'), 'base64'));
        nextChunk += 1;
        if (!ready) {
          await new Promise((resolve) => response.once('drain', resolve));
        }
      }

      if (currentRequest.status === 'ready') {
        const chunkCount = Number(currentRequest.result?.chunkCount || 0);
        if (nextChunk >= chunkCount) {
          if (!headersSent) {
            response.writeHead(200, {
              'content-type': 'application/octet-stream',
              'content-disposition': filenameHeader(currentRequest.result?.fileName || share.name || 'download'),
              'cache-control': 'no-store',
            });
          }
          incrementShareDownload(share.token);
          response.end();
          return;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    throw new Error('Storage PC did not respond');
  } catch (error) {
    if (!response.headersSent) {
      sendPublicMessage(response, 503, 'File unavailable', error instanceof Error ? error.message : 'Could not download this file');
    } else {
      response.destroy(error);
    }
  } finally {
    cleanupPublicRequest(share.pairId, requestId);
  }
};

const renderSharedFolder = async (request, response, share, pair, childPath = '') => {
  const relativePath = publicChildPath(share, childPath);
  const requestId = createPublicRequest(readState(), share, 'list', relativePath);

  try {
    const { request: completedRequest } = await waitForPublicRequest(share.pairId, requestId, 120000);
    const listing = completedRequest.result || { entries: [] };
    const currentChild = stripPathPrefix(share.relativePath, listing.path || relativePath);
    const entries = Array.isArray(listing.entries) ? listing.entries : [];
    const rows = entries.map((entry) => {
      const entryChild = stripPathPrefix(share.relativePath, entry.relativePath || '');
      const href = entry.type === 'directory'
        ? `/s/${share.token}?path=${encodeURIComponent(entryChild)}`
        : `/s/${share.token}/download?path=${encodeURIComponent(entryChild)}`;
      const action = entry.type === 'directory' ? 'Open' : 'Download';
      return `<tr>
        <td>${escapeHtml(entry.name)}</td>
        <td>${entry.type === 'directory' ? 'Folder' : 'File'}</td>
        <td>${escapeHtml(entry.sizeLabel || '-')}</td>
        <td><a href="${href}">${action}</a></td>
      </tr>`;
    }).join('');
    const upPath = currentChild.split('/').filter(Boolean).slice(0, -1).join('/');
    const upLink = currentChild ? `<a class="up" href="/s/${share.token}${upPath ? `?path=${encodeURIComponent(upPath)}` : ''}">Up</a>` : '';

    sendHtml(response, 200, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(share.name)}</title>
  <style>
    body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f1ea;color:#171a1d}
    main{max-width:920px;margin:0 auto;padding:24px}
    header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:14px}
    h1{margin:0;font-size:22px;letter-spacing:0}.meta{color:#68716d;font-size:13px;font-weight:750}.up{font-weight:850;color:#0f766e;text-decoration:none}
    table{width:100%;border-collapse:collapse;border:1px solid #ded8ce;background:#fffdf8;border-radius:8px;overflow:hidden}
    th,td{padding:12px;border-bottom:1px solid #eee8dd;text-align:left;font-size:14px}th{background:#faf7ef;color:#68716d;font-size:12px;text-transform:uppercase}
    tr:last-child td{border-bottom:0}a{color:#0f766e;font-weight:850}.empty{display:grid;min-height:96px;place-items:center;border:1px solid #ded8ce;background:#fffdf8;border-radius:8px;color:#68716d;font-weight:750}
  </style>
</head>
<body>
  <main>
    <header>
      <div><h1>${escapeHtml(share.name)}</h1><div class="meta">${escapeHtml(currentChild || 'Shared folder')} · ${entries.length} items</div></div>
      ${upLink}
    </header>
    ${entries.length === 0 ? '<div class="empty">Empty</div>' : `<table><thead><tr><th>Name</th><th>Kind</th><th>Size</th><th></th></tr></thead><tbody>${rows}</tbody></table>`}
  </main>
</body>
</html>`);
  } catch (error) {
    sendPublicMessage(response, 503, 'Folder unavailable', error instanceof Error ? error.message : 'Could not open this folder');
  } finally {
    cleanupPublicRequest(share.pairId, requestId);
  }
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
    cancelDuplicateUploads(pair, request);
    pair.requests[requestId] = request;
    writeState(prunePairs(state));

    return { ok: true, requestId };
  },

  'POST /api/drive/shares/create': async (body, request) => {
    const state = prunePairs(readState());
    const pair = verifyPair(state, body.pairId, body.token);

    if (!pair) {
      return { status: 401, payload: { ok: false, error: 'Not linked' } };
    }

    let relativePath;
    try {
      relativePath = normalizeRemotePath(body.relativePath);
    } catch {
      return { status: 400, payload: { ok: false, error: 'Invalid path' } };
    }

    if (!relativePath) {
      return { status: 400, payload: { ok: false, error: 'Select a file or folder' } };
    }

    if (!canSharePathForToken(pair, body.token, relativePath)) {
      return { status: 403, payload: { ok: false, error: 'Path is outside your vault' } };
    }

    const token = crypto.randomBytes(18).toString('base64url');
    const type = body.type === 'directory' ? 'directory' : 'file';
    const name = safePathName(body.name || relativePath.split('/').filter(Boolean).slice(-1)[0] || 'Shared item', 'Shared item');
    const share = {
      token,
      pairId: pair.id,
      folderId: String(body.folderId || '').slice(0, 80),
      relativePath,
      name,
      type,
      createdAt: now(),
      expiresAt: new Date(Date.now() + shareTtlMs).toISOString(),
      maxDownloads: shareMaxDownloads,
      downloadCount: 0,
      createdBy: tokenDeviceId(pair, body.token),
    };

    state.shares = state.shares || {};
    state.shares[token] = share;
    writeState(state);

    return { ok: true, share: publicSharePayload(share, request) };
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

    if (request.status !== 'uploading') {
      return { status: 409, payload: { ok: false, error: 'Upload is no longer active' } };
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

    if (request.status !== 'uploading') {
      return { ok: true, ignored: true };
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

      if (request.type === 'upload' && request.status !== 'uploading') {
        return { status: 409, payload: { ok: false, error: 'Upload is no longer active' } };
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

const handlePublicShareRoute = async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false;
  }

  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 's' || !parts[1] || parts.length > 3) {
    return false;
  }

  const token = parts[1];
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(token)) {
    sendPublicMessage(response, 404, 'Link not found', 'This share link is invalid.');
    return true;
  }

  const current = shareFromRequest(token);
  if (current.error) {
    sendPublicMessage(response, 410, 'Link expired', current.error);
    return true;
  }

  const childPath = normalizeRemotePath(url.searchParams.get('path') || '');
  const isDownloadRoute = parts[2] === 'download';

  if (request.method === 'HEAD') {
    response.writeHead(200, { 'cache-control': 'no-store' });
    response.end();
    return true;
  }

  if (isDownloadRoute || current.share.type === 'file') {
    await sendSharedFile(request, response, current.share, current.pair, childPath);
    return true;
  }

  await renderSharedFolder(request, response, current.share, current.pair, childPath);
  return true;
};

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    send(response, 204, {});
    return;
  }

  try {
    if (await handlePublicShareRoute(request, response)) {
      return;
    }
  } catch (error) {
    sendPublicMessage(response, 400, 'Link error', error instanceof Error ? error.message : 'Could not open this link');
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
