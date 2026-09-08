#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIMIT_PERCENT="${RESOURCE_LIMIT_PERCENT:-90}"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  shift
fi

if ! [[ "$LIMIT_PERCENT" =~ ^[0-9]+$ ]] || (( LIMIT_PERCENT < 10 || LIMIT_PERCENT > 90 )); then
  echo "RESOURCE_LIMIT_PERCENT 必须是 10 到 90 的整数" >&2
  exit 1
fi

host_cpus="$(nproc)"
host_memory_kib="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo)"
if ! [[ "$host_cpus" =~ ^[0-9]+$ && "$host_memory_kib" =~ ^[0-9]+$ ]]; then
  echo "无法读取宿主机 CPU 或内存容量" >&2
  exit 1
fi

cpu_ceiling="$(awk -v count="$host_cpus" -v percent="$LIMIT_PERCENT" 'BEGIN { printf "%.2f", count * percent / 100 }')"
memory_ceiling_mib="$((host_memory_kib * LIMIT_PERCENT / 100 / 1024))"

# Preserve the repository's conservative defaults, but clamp user overrides
# so this deployment entry point can never assign more than the host ceiling.
requested_cpus="${CONTAINER_CPUS:-5.33}"
container_cpus="$(awk -v requested="$requested_cpus" -v ceiling="$cpu_ceiling" 'BEGIN {
  value = requested + 0;
  if (value <= 0 || value > ceiling) value = ceiling;
  printf "%.2f", value;
}')"

memory_bytes() {
  local normalized
  normalized="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
  numfmt --from=iec "$normalized"
}

requested_memory_bytes="$(memory_bytes "${CONTAINER_MEMORY_LIMIT:-4g}")"
requested_swap_bytes="$(memory_bytes "${CONTAINER_MEMORY_SWAP_LIMIT:-5g}")"
memory_ceiling_bytes="$((memory_ceiling_mib * 1024 * 1024))"
if (( requested_memory_bytes <= 0 || requested_memory_bytes > memory_ceiling_bytes )); then
  requested_memory_bytes="$memory_ceiling_bytes"
fi
if (( requested_swap_bytes < requested_memory_bytes )); then
  requested_swap_bytes="$requested_memory_bytes"
elif (( requested_swap_bytes > memory_ceiling_bytes )); then
  requested_swap_bytes="$memory_ceiling_bytes"
fi

export CONTAINER_CPUS="$container_cpus"
export CONTAINER_MEMORY_LIMIT="$((requested_memory_bytes / 1024 / 1024))m"
export CONTAINER_MEMORY_SWAP_LIMIT="$((requested_swap_bytes / 1024 / 1024))m"

echo "Container limits: cpus=${CONTAINER_CPUS}, memory=${CONTAINER_MEMORY_LIMIT}, memory+swap=${CONTAINER_MEMORY_SWAP_LIMIT} (host ceiling ${LIMIT_PERCENT}%)"
if [[ "$DRY_RUN" == true ]]; then
  exit 0
fi
exec docker compose -f "$ROOT/compose.yaml" --project-directory "$ROOT" up -d "$@"
