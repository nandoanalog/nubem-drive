# Nubem Drive

Private folder cloud with two desktop apps:

- `Nubem Server` runs on the HDD/storage PC.
- `Nubem Drive` runs on client PCs.

Clients link to a server vault with a code. After that, `Add to Nubem` copies selected folders into that vault and resumes missing files if the connection drops.

## Apps

### Nubem Server

- Linux app for the HDD/storage machine.
- Adds storage folders that can be shared by code.
- Installs the user service `nubem-server-storage.service`.
- Keeps server state in `~/.config/nubem-server/state.json`.

### Nubem Drive

- Client app for normal computers.
- Creates a local client vault automatically.
- Lets the user rename the vault.
- Adds the right-click folder action `Add or remove from Nubem`.
- Keeps client state in `~/.config/nubem-drive/state.json`.

## Development

```bash
npm install
npm run dev
npm run dev:server
npm run storage
```

## Checks

```bash
npm run lint
npm run build
```

## Packaging

Linux packages are built from this machine. Windows client installers are built and released from the Windows machine.

```bash
npm run dist:client:linux
npm run dist:server:linux
npm run dist:linux
```

Generated Linux packages:

- `release/Nubem-Drive-<version>-amd64.deb`
- `release/Nubem-Server-<version>-amd64.deb`

## Storage PC

Install or update the server app:

```bash
sudo apt install --reinstall ./release/Nubem-Server-<version>-amd64.deb
systemctl --user daemon-reload
systemctl --user enable --now nubem-server-storage.service
systemctl --user restart nubem-server-storage.service
systemctl --user status nubem-server-storage.service --no-pager
```

Watch the storage worker:

```bash
journalctl --user -u nubem-server-storage.service -f
```

The server UI should say `Server`. The client UI should say `Client`.
