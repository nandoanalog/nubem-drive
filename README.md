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
- Lightweight Node relay service
- Download page for installers

## Development

```bash
npm install
npm run dev
```

## Checks

```bash
npm run lint
npm run build
```

## Packaging

```bash
npm run dist:linux
npx electron-builder --win dir --x64
NSISDIR="$HOME/.cache/electron-builder/nsis/nsis-3.0.4.1" \
  "$HOME/.cache/electron-builder/nsis/nsis-3.0.4.1/linux/makensis" \
  build/nsis/manual-installer.nsi
```
