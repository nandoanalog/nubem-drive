# Nubem Drive

Private folder cloud desktop app.

Nubem Drive is an Electron + React app for marking local folders as cloud folders, pairing devices through a lightweight VPS relay, and giving each computer access to the shared storage flow.

## Current Features

- Linux and Windows desktop app
- Right-click folder action: `Cloud`
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
