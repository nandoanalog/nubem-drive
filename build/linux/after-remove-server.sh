#!/bin/sh
set -e

target_user="${SUDO_USER:-}"
if [ -z "$target_user" ] && [ -n "${PKEXEC_UID:-}" ]; then
  target_user="$(getent passwd "$PKEXEC_UID" 2>/dev/null | cut -d: -f1 || true)"
fi

if [ -n "$target_user" ] && command -v systemctl >/dev/null 2>&1 && command -v runuser >/dev/null 2>&1; then
  target_uid="$(id -u "$target_user" 2>/dev/null || true)"
  if [ -n "$target_uid" ]; then
    runuser -u "$target_user" -- env XDG_RUNTIME_DIR="/run/user/$target_uid" systemctl --user disable --now nubem-server-storage.service >/dev/null 2>&1 || true
  fi
fi

rm -f /usr/bin/nubem-server-storage
rm -f /usr/lib/systemd/user/nubem-server-storage.service

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
