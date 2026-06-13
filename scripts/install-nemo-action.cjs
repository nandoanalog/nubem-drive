const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const actionDir = path.join(os.homedir(), '.local', 'share', 'nemo', 'actions');
const actionPath = path.join(actionDir, 'nubem-cloud-folder.nemo_action');
const nodePath = process.execPath;
const commandPath = path.join(root, 'scripts', 'cloud-folder.cjs');

const action = `[Nemo Action]
Active=true
Name=Cloud
Comment=Add folder to Nubem Drive
Exec=${nodePath} ${commandPath} %F
Icon-Name=folder-remote-symbolic
Selection=notnone
Extensions=dir;
`;

fs.mkdirSync(actionDir, { recursive: true });
fs.writeFileSync(actionPath, action, { mode: 0o644 });
fs.chmodSync(commandPath, 0o755);

spawnSync('nemo', ['--quit'], { stdio: 'ignore' });

console.log(actionPath);
