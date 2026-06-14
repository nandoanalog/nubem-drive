#!/usr/bin/env node

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_REPO = 'nandoanalog/nubem-drive';
const DEFAULT_ISSUE = '1';
const DEFAULT_POLL_MS = 30_000;
const MAX_COMMENT_LENGTH = 60_000;

const args = parseArgs(process.argv.slice(2));
const repo = args.repo || process.env.HANDOFF_REPO || DEFAULT_REPO;
const issue = args.issue || process.env.HANDOFF_ISSUE || DEFAULT_ISSUE;
const target = args.target || process.env.HANDOFF_TARGET || inferTarget();
const otherTarget = args.next || process.env.HANDOFF_NEXT || inferOtherTarget(target);
const pollMs = Number(args.poll || process.env.HANDOFF_POLL_MS || DEFAULT_POLL_MS);
const workdir = path.resolve(args.workdir || process.env.HANDOFF_WORKDIR || process.cwd());
const ghBin = resolveTool(args.gh || process.env.GH_BIN || 'gh', ghCandidates());
const codexBin = resolveTool(args.codex || process.env.CODEX_BIN || 'codex', codexCandidates());
const statePath = path.resolve(
  args.state ||
    process.env.HANDOFF_STATE ||
    path.join(os.homedir(), '.config', 'nubem-drive', `codex-handoff-${slug(target)}.json`),
);
const dryRun = Boolean(args['dry-run'] || process.env.HANDOFF_DRY_RUN);
const once = Boolean(args.once || process.env.HANDOFF_ONCE);

let state = readJson(statePath, { handled: [] });
let busy = false;

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  requireTool(ghBin);
  requireTool(codexBin);

  const currentUser = runGh(['api', 'user', '-q', '.login']).trim();
  const allowedAuthors = new Set(
    (args['allowed-authors'] || process.env.HANDOFF_ALLOWED_AUTHORS || currentUser)
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );

  console.log(`Nubem Drive handoff loop`);
  console.log(`repo=${repo} issue=${issue} target="${target}" workdir=${workdir}`);
  console.log(`gh=${ghBin}`);
  console.log(`codex=${codexBin}`);
  console.log(`trusted-authors=${[...allowedAuthors].join(', ')}`);
  console.log(dryRun ? 'dry-run=true' : `poll=${pollMs}ms`);

  await tick(allowedAuthors);
  if (once) return;

  setInterval(() => {
    if (busy) return;
    busy = true;
    tick(allowedAuthors)
      .catch((error) => console.error(error.stack || error.message))
      .finally(() => {
        busy = false;
      });
  }, pollMs);
}

async function tick(allowedAuthors) {
  const thread = fetchThread();
  const handoff = latestHandoffForTarget(thread, target, allowedAuthors);

  if (!handoff) {
    console.log(`[${new Date().toISOString()}] no handoff for ${target}`);
    return;
  }

  if (state.handled.includes(handoff.key)) {
    console.log(`[${new Date().toISOString()}] already handled ${handoff.key}`);
    return;
  }

  const claim = findWinningClaim(thread, handoff.key, target);
  if (claim && claim.token !== state.lastClaimToken) {
    console.log(`[${new Date().toISOString()}] task already claimed by ${claim.author}`);
    return;
  }

  const token = state.lastClaimToken || `${os.hostname()}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (!claim) {
    postComment(formatClaim(handoff.key, target, token));
    state.lastClaimToken = token;
    writeJson(statePath, state);

    const refreshed = fetchThread();
    const winningClaim = findWinningClaim(refreshed, handoff.key, target);
    if (!winningClaim || winningClaim.token !== token) {
      console.log(`[${new Date().toISOString()}] lost claim for ${handoff.key}`);
      return;
    }
  }

  console.log(`[${new Date().toISOString()}] handling ${handoff.key}`);
  if (dryRun) {
    console.log(handoff.block);
    return;
  }

  const finalMessage = runCodex(handoff);
  const comment = clampComment(finalMessage || fallbackHandoff('fixed', 'Codex finished without a final message.'));
  postComment(comment);

  state.handled = [...new Set([...(state.handled || []), handoff.key])].slice(-100);
  delete state.lastClaimToken;
  writeJson(statePath, state);
}

function fetchThread() {
  return JSON.parse(
    runGh([
      'issue',
      'view',
      issue,
      '--repo',
      repo,
      '--comments',
      '--json',
      'author,body,comments,number,title,url',
    ]),
  );
}

function latestHandoffForTarget(thread, wantedTarget, allowedAuthors) {
  const entries = [];
  const issueAuthor = thread.author && thread.author.login;
  if (thread.body && allowedAuthors.has(issueAuthor)) {
    entries.push({
      source: 'issue-body',
      author: issueAuthor,
      createdAt: '0000-00-00T00:00:00Z',
      body: thread.body,
    });
  }

  for (const comment of thread.comments || []) {
    const author = comment.author && comment.author.login;
    if (!allowedAuthors.has(author)) continue;
    entries.push({
      source: `comment-${comment.id}`,
      author,
      createdAt: comment.createdAt,
      body: comment.body || '',
    });
  }

  const handoffs = [];
  for (const entry of entries) {
    for (const block of extractHandoffBlocks(entry.body)) {
      const to = firstMatch(block, /^HANDOFF TO:\s*(.+)$/im);
      if (!to || normalize(to) !== normalize(wantedTarget)) continue;
      handoffs.push({
        ...entry,
        block,
        key: `${entry.source}:${hash(block)}`,
      });
    }
  }

  return handoffs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1);
}

function extractHandoffBlocks(body) {
  const blocks = [];
  const fenceRegex = /```(?:text)?\s*([\s\S]*?HANDOFF TO:[\s\S]*?)```/gi;
  let match;
  while ((match = fenceRegex.exec(body))) {
    blocks.push(match[1].trim());
  }

  if (!blocks.length && /HANDOFF TO:/i.test(body)) {
    blocks.push(body.trim());
  }

  return blocks;
}

function findWinningClaim(thread, taskKey, wantedTarget) {
  const claims = [];
  for (const comment of thread.comments || []) {
    const body = comment.body || '';
    if (!body.includes('HANDOFF CLAIMED')) continue;
    const task = firstMatch(body, /^TASK:\s*(.+)$/im);
    const claimTarget = firstMatch(body, /^TARGET:\s*(.+)$/im);
    const token = firstMatch(body, /^TOKEN:\s*(.+)$/im);
    if (task !== taskKey || normalize(claimTarget) !== normalize(wantedTarget) || !token) continue;
    claims.push({ token, author: comment.author && comment.author.login, createdAt: comment.createdAt });
  }

  return claims.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
}

function runCodex(handoff) {
  const outputPath = path.join(os.tmpdir(), `nubem-drive-handoff-${process.pid}-${Date.now()}.txt`);
  const prompt = [
    `You are the ${target} side of the Nubem Drive Codex handoff loop.`,
    '',
    'Repository: nandoanalog/nubem-drive',
    `GitHub issue: https://github.com/${repo}/issues/${issue}`,
    '',
    'Hard rules:',
    '- Work only on Nubem Drive / nandoanalog/nubem-drive.',
    '- Do not touch the separate Nubem app.',
    '- Keep the final response short.',
    '- If you change code, commit and push before finishing.',
    '- Do not post a GitHub issue comment yourself; this runner will post your final response.',
    '- Your final response must end with exactly one fenced handoff block for the other machine.',
    '',
    'Use this handoff format at the end:',
    '```text',
    `HANDOFF TO: ${otherTarget}`,
    'STATE: blocked | needs-test | fixed | investigating',
    'COMMIT: <sha or none>',
    'VERSION: <version or none>',
    'PLEASE DO:',
    '- <next action>',
    'RESULTS:',
    '- <what you did/saw>',
    '```',
    '',
    'Task to handle:',
    '```text',
    handoff.block,
    '```',
  ].join('\n');

  const result = spawnSync(
    codexBin,
    [
      'exec',
      '--cd',
      workdir,
      '--sandbox',
      'danger-full-access',
      '--ask-for-approval',
      'never',
      '--output-last-message',
      outputPath,
      '-',
    ],
    {
      cwd: workdir,
      input: prompt,
      encoding: 'utf8',
      stdio: ['pipe', 'inherit', 'inherit'],
      env: process.env,
    },
  );

  let finalMessage = '';
  if (fs.existsSync(outputPath)) {
    finalMessage = fs.readFileSync(outputPath, 'utf8').trim();
    fs.rmSync(outputPath, { force: true });
  }

  if (result.status !== 0) {
    return fallbackHandoff('blocked', `Codex exited with status ${result.status}. ${finalMessage}`.trim());
  }

  if (!/HANDOFF TO:/i.test(finalMessage)) {
    return `${finalMessage}\n\n${fallbackHandoff('needs-test', 'Codex finished, but did not include a handoff block.')}`.trim();
  }

  return finalMessage;
}

function fallbackHandoff(stateValue, resultLine) {
  return [
    'Automated handoff runner result.',
    '',
    '```text',
    `HANDOFF TO: ${otherTarget}`,
    `STATE: ${stateValue}`,
    'COMMIT: none',
    'VERSION: none',
    'PLEASE DO:',
    '- Inspect the previous runner failure and decide the next step.',
    'RESULTS:',
    `- ${resultLine.replace(/\s+/g, ' ').slice(0, 500)}`,
    '```',
  ].join('\n');
}

function postComment(body) {
  runGh(['issue', 'comment', issue, '--repo', repo, '--body', body]);
}

function formatClaim(taskKey, claimTarget, token) {
  return [
    'HANDOFF CLAIMED',
    `TARGET: ${claimTarget}`,
    `TASK: ${taskKey}`,
    `TOKEN: ${token}`,
    `HOST: ${os.hostname()}`,
  ].join('\n');
}

function clampComment(body) {
  if (body.length <= MAX_COMMENT_LENGTH) return body;
  const suffix = '\n\n[handoff runner truncated this comment]\n';
  return body.slice(0, MAX_COMMENT_LENGTH - suffix.length) + suffix;
}

function runGh(argsList) {
  return execFileSync(ghBin, argsList, { cwd: workdir, encoding: 'utf8' });
}

function requireTool(tool) {
  if (path.isAbsolute(tool) && fs.existsSync(tool)) return;
  const command = process.platform === 'win32' ? 'where' : 'command';
  const argsList = process.platform === 'win32' ? [tool] : ['-v', tool];
  try {
    execFileSync(command, argsList, { stdio: 'ignore', shell: process.platform !== 'win32' });
  } catch {
    throw new Error(`Missing required tool: ${tool}`);
  }
}

function resolveTool(preferred, candidates) {
  if (preferred !== 'codex' && preferred !== 'gh') return preferred;
  if (toolOnPath(preferred)) return preferred;
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || preferred;
}

function toolOnPath(tool) {
  try {
    const command = process.platform === 'win32' ? 'where' : 'command';
    const argsList = process.platform === 'win32' ? [tool] : ['-v', tool];
    execFileSync(command, argsList, { stdio: 'ignore', shell: process.platform !== 'win32' });
    return true;
  } catch {
    return false;
  }
}

function ghCandidates() {
  if (process.platform === 'win32') {
    return [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'GitHub CLI', 'gh.exe'),
    ];
  }

  return ['/usr/bin/gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh'];
}

function codexCandidates() {
  const extensionRoot = path.join(os.homedir(), '.vscode', 'extensions');
  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const platformDir = codexPlatformDir();
  const candidates = [];

  try {
    const extensions = fs
      .readdirSync(extensionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const extension of extensions) {
      candidates.push(path.join(extensionRoot, extension, 'bin', platformDir, binaryName));
    }
  } catch {
    // VS Code is not installed or the extension path is different.
  }

  if (process.platform === 'win32') {
    candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Codex', binaryName));
  } else {
    candidates.push('/usr/local/bin/codex', '/opt/homebrew/bin/codex');
  }

  return candidates;
}

function codexPlatformDir() {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
  if (process.platform === 'win32') return `win32-${arch}`;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  return `linux-${arch}`;
}

function parseArgs(list) {
  const parsed = {};
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = list[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function firstMatch(text, regex) {
  const match = text && text.match(regex);
  return match ? match[1].trim() : '';
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function slug(value) {
  return normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'codex';
}

function hash(value) {
  let result = 5381;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 33) ^ value.charCodeAt(index);
  }
  return (result >>> 0).toString(16);
}

function inferTarget() {
  return process.platform === 'win32' ? 'Windows Codex' : 'Linux Codex';
}

function inferOtherTarget(currentTarget) {
  return normalize(currentTarget) === 'windows codex' ? 'Linux Codex' : 'Windows Codex';
}
