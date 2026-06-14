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
