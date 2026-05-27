#!/bin/sh
# Start as root just long enough to fix ownership on /app/uploads — the
# docker-compose named volume `uploads:/app/uploads` overlays whatever the
# image set, so a stale volume from an older image variant can leave the
# mount root-owned even though the Dockerfile chowned it to appuser. Once
# the mount is writable, drop to appuser via gosu and exec the CMD.
set -e

if [ "$(id -u)" = "0" ]; then
    chown -R appuser:appuser /app/uploads 2>/dev/null || true
    exec gosu appuser "$@"
fi

exec "$@"
