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
- Strong one-time pairing codes with relay rate limiting
- Platform update manifest with background update checks
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

Linux packages are built from this machine. Windows installers are built and released from the Windows machine.

```bash
npm run dist:linux
```

## Codex Handoff Loop

Use GitHub issue `#1` as the shared mailbox between the Linux and Windows Codex sessions.

```bash
npm run handoff:linux
npm run handoff:windows
```

Each side needs `gh` and `codex` logged in. The runner only trusts handoff comments from the authenticated GitHub user unless `HANDOFF_ALLOWED_AUTHORS` is set.
