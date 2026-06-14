# Nubem Drive

Private folder cloud desktop app.

Nubem Drive is an Electron + React app for marking local folders as cloud folders, pairing devices through a lightweight VPS relay, and giving each computer access to the shared storage flow.

## Current Features

- Linux and Windows desktop app
- Right-click folder action: `Add or remove from Nubem`
- Single-instance desktop behavior
- Device pairing through `drive.nubem.org`
- Remote folder browsing from paired devices
- Relay-backed file downloads
- Headless storage server for the HDD machine
- Persistent client upload queue with file-level resume
- Strong one-time pairing codes with relay rate limiting
- Platform update manifest with background update checks
- Lightweight Node relay service
- Download page for installers

## Development

```bash
npm install
npm run dev
npm run storage
```

On Linux installs, the storage server is also installed as `nubem-drive-storage` and a user service named `nubem-drive-storage.service`.

## Updating the Storage PC

The storage PC must run the same current repo build as the Windows client. If the Windows app shows `Storage PC is offline`, `Storage PC did not respond`, or a folder remains queued, update and restart the storage service on the Linux storage PC.

```bash
cd ~/Documents/cloud
git pull --ff-only
npm ci
npm run build
npm run dist:linux
sudo apt install -y ./release/*.deb
systemctl --user daemon-reload
systemctl --user enable --now nubem-drive-storage.service
systemctl --user restart nubem-drive-storage.service
systemctl --user status nubem-drive-storage.service --no-pager
```

To watch the storage worker process requests:

```bash
journalctl --user -u nubem-drive-storage.service -f
```

After restart, create a fresh vault code on the storage PC and join it from the Windows client. The client should show the storage device as `online`; only then are queued folders expected to copy into the vault.

## Checks

```bash
npm run lint
npm run build
```

## Packaging

Linux packages are built from this machine. Windows installers are built and released from the Windows machine.

```bash
npm run dist:linux
```
