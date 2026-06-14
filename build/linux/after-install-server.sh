#!/bin/sh
set -e

cat > /usr/bin/nubem-server-storage <<'EOF'
#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
export NUBEM_DRIVE_STATE="${NUBEM_DRIVE_STATE:-$HOME/.config/nubem-server/state.json}"
exec "/opt/Nubem Server/nubem-server" "/opt/Nubem Server/resources/app.asar/server/storage-node.cjs" "$@"
EOF

chmod 755 /usr/bin/nubem-server-storage

mkdir -p /usr/lib/systemd/user

cat > /usr/lib/systemd/user/nubem-server-storage.service <<'EOF'
[Unit]
Description=Nubem Server Storage
After=network-online.target

[Service]
ExecStart=/usr/bin/nubem-server-storage
Restart=always
RestartSec=5
Environment=NUBEM_STORAGE_POLL_MS=5000

[Install]
WantedBy=default.target
EOF

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
