#!/bin/sh
set -e

rm -f /usr/share/nemo/actions/nubem-cloud-folder.nemo_action
rm -f /usr/bin/nubem-drive-cloud-folder

if command -v nemo >/dev/null 2>&1; then
  nemo --quit >/dev/null 2>&1 || true
fi
