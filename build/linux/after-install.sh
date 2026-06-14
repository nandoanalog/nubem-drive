#!/bin/sh
set -e

mkdir -p /usr/share/nemo/actions

find /home /root -path '*/.local/share/nemo/actions/nubem-cloud-folder.nemo_action' -type f -delete 2>/dev/null || true

cat > /usr/bin/nubem-drive-cloud-folder <<'EOF'
#!/bin/bash
args=()
for folder in "$@"; do
  args+=("nubem-cloud-folder:$folder")
done
exec "/opt/Nubem Drive/nubem-drive" "${args[@]}"
EOF

chmod 755 /usr/bin/nubem-drive-cloud-folder

cat > /usr/bin/nubem-drive-storage <<'EOF'
#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
exec "/opt/Nubem Drive/nubem-drive" "/opt/Nubem Drive/resources/app.asar/server/storage-node.cjs" "$@"
EOF

chmod 755 /usr/bin/nubem-drive-storage

mkdir -p /usr/lib/systemd/user

cat > /usr/lib/systemd/user/nubem-drive-storage.service <<'EOF'
[Unit]
Description=Nubem Drive Storage
After=network-online.target

[Service]
ExecStart=/usr/bin/nubem-drive-storage
Restart=always
RestartSec=5
Environment=NUBEM_STORAGE_POLL_MS=5000

[Install]
WantedBy=default.target
EOF

cat > /usr/share/nemo/actions/nubem-cloud-folder.nemo_action <<'EOF'
[Nemo Action]
Active=true
Name=Add to cloud
Comment=Add folder to Nubem Drive
Exec=nubem-drive-cloud-folder %F
Icon-Name=folder-remote-symbolic
Selection=notnone
Extensions=dir;
EOF

if command -v nemo >/dev/null 2>&1; then
  nemo --quit >/dev/null 2>&1 || true
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload >/dev/null 2>&1 || true
fi

target_user="${SUDO_USER:-}"
if [ -z "$target_user" ] && [ -n "${PKEXEC_UID:-}" ]; then
  target_user="$(getent passwd "$PKEXEC_UID" 2>/dev/null | cut -d: -f1 || true)"
fi

if [ -n "$target_user" ] && command -v systemctl >/dev/null 2>&1 && command -v runuser >/dev/null 2>&1; then
  target_uid="$(id -u "$target_user" 2>/dev/null || true)"
  if [ -n "$target_uid" ]; then
    loginctl enable-linger "$target_user" >/dev/null 2>&1 || true
    runuser -u "$target_user" -- env XDG_RUNTIME_DIR="/run/user/$target_uid" systemctl --user daemon-reload >/dev/null 2>&1 || true
    runuser -u "$target_user" -- env XDG_RUNTIME_DIR="/run/user/$target_uid" systemctl --user enable --now nubem-drive-storage.service >/dev/null 2>&1 || true
  fi
fi
