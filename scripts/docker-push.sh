#!/usr/bin/env bash
# 本地构建并推送到 Docker Hub（不走 GitHub Actions / 不需要 DOCKERHUB_TOKEN secret）
set -euo pipefail

IMAGE="${IMAGE:-knighttools/read2xsgg}"
TAG="${TAG:-latest}"
PLATFORM="${PLATFORM:-linux/amd64,linux/arm64}"
BASE_IMAGE="${BASE_IMAGE:-node:22-bookworm-slim}"
BUILD_NETWORK="${BUILD_NETWORK:-default}"
BUILDER="${BUILDER:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT_TAG="sha-$(git -C "$ROOT" rev-parse --short HEAD)"

builder_args=()
if [[ -n "$BUILDER" ]]; then
  builder_args+=(--builder "$BUILDER")
fi

proxy_build_args=()
for proxy_name in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do
  if [[ -n "${!proxy_name:-}" ]]; then
    proxy_build_args+=(--build-arg "${proxy_name}=${!proxy_name}")
  fi
done

cd "$ROOT"

if [[ "${SKIP_VALIDATION:-0}" != "1" ]]; then
  echo "Running offline XBS action-chain tests before publishing..."
  npm test
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker 未运行，请先启动 Docker Desktop。" >&2
  exit 1
fi

GIT_SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
echo "Building and pushing ${IMAGE}:${TAG} (${PLATFORM}) from ${GIT_SHA}"
docker buildx build \
  "${builder_args[@]}" \
  --platform "${PLATFORM}" \
  --network "${BUILD_NETWORK}" \
  --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
  --build-arg "GIT_SHA=${GIT_SHA}" \
  "${proxy_build_args[@]}" \
  -t "${IMAGE}:${TAG}" \
  -t "${IMAGE}:${COMMIT_TAG}" \
  --push \
  .

echo "Done. Pull with: docker pull ${IMAGE}:${TAG}"
