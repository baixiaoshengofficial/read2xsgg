#!/bin/sh
set -eu

data_dir="${DATA_DIR:-/data}"

# A bind mount replaces the image's /data directory, including its ownership.
# Repair it before dropping privileges so `./data:/data` works on a fresh host.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$data_dir"
  chown -R node:node "$data_dir"
  exec su-exec node "$@"
fi

exec "$@"
