#!/bin/sh
# Mounted volumes are root-owned. Give the state directory to the unprivileged user, then drop root.
set -eu
if [ -n "${PLUMBLINE_STATE_FILE:-}" ]; then
  d=$(dirname "$PLUMBLINE_STATE_FILE")
  mkdir -p "$d"
  chown node:node "$d"
  chmod 0700 "$d"
fi
exec su-exec node node /app/dist/index.js "$@"
