#!/usr/bin/env bash
# 本地构建并推送到 Docker Hub（不走 GitHub Actions / 不需要 DOCKERHUB_TOKEN secret）
set -euo pipefail

IMAGE="${IMAGE:-knighttools/read2xsgg}"
TAG="${TAG:-latest}"
PLATFORM="${PLATFORM:-linux/amd64,linux/arm64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT_TAG="sha-$(git -C "$ROOT" rev-parse --short HEAD)"

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
  --platform "${PLATFORM}" \
  --build-arg "GIT_SHA=${GIT_SHA}" \
  -t "${IMAGE}:${TAG}" \
  -t "${IMAGE}:${COMMIT_TAG}" \
  --push \
  .

echo "Done. Pull with: docker pull ${IMAGE}:${TAG}"
