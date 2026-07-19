#!/usr/bin/env bash
# 本地构建并推送到 Docker Hub（不走 GitHub Actions / 不需要 DOCKERHUB_TOKEN secret）
set -euo pipefail

IMAGE="${IMAGE:-knighttools/read2xsgg}"
TAG="${TAG:-latest}"
PLATFORM="${PLATFORM:-linux/amd64,linux/arm64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT_TAG="sha-$(git -C "$ROOT" rev-parse --short HEAD)"

cd "$ROOT"

if ! docker info >/dev/null 2>&1; then
  echo "Docker 未运行，请先启动 Docker Desktop。" >&2
  exit 1
fi

echo "Building and pushing ${IMAGE}:${TAG} (${PLATFORM}) from ${COMMIT_TAG#sha-}"
docker buildx build \
  --platform "${PLATFORM}" \
  -t "${IMAGE}:${TAG}" \
  -t "${IMAGE}:${COMMIT_TAG}" \
  --push \
  .

echo "Done. Pull with: docker pull ${IMAGE}:${TAG}"
