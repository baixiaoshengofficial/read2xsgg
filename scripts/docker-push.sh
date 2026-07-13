#!/usr/bin/env bash
# 本地构建并推送到 Docker Hub（不走 GitHub Actions / 不需要 DOCKERHUB_TOKEN secret）
set -euo pipefail

IMAGE="${IMAGE:-knighttools/read2xsgg}"
TAG="${TAG:-latest}"
PLATFORM="${PLATFORM:-linux/amd64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"

if ! docker info >/dev/null 2>&1; then
  echo "Docker 未运行，请先启动 Docker Desktop。" >&2
  exit 1
fi

echo "Building ${IMAGE}:${TAG} (${PLATFORM}) from $(git rev-parse --short HEAD)"
docker build \
  --platform "${PLATFORM}" \
  -t "${IMAGE}:${TAG}" \
  -t "${IMAGE}:sha-$(git rev-parse --short HEAD)" \
  .

echo "Pushing ${IMAGE}:${TAG}"
docker push "${IMAGE}:${TAG}"
docker push "${IMAGE}:sha-$(git rev-parse --short HEAD)"

echo "Done. Pull with: docker pull ${IMAGE}:${TAG}"
