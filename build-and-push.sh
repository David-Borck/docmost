#!/bin/bash
set -e

# Configuration
REGISTRY="registry.david-borck.de"
IMAGE_NAME="docmost"
VERSION=${1:-latest}

echo "Building Docker image..."
docker build -t ${REGISTRY}/${IMAGE_NAME}:${VERSION} .

echo "Tagging as latest..."
if [ "$VERSION" != "latest" ]; then
  docker tag ${REGISTRY}/${IMAGE_NAME}:${VERSION} ${REGISTRY}/${IMAGE_NAME}:latest
fi

echo "Pushing to registry..."
docker push ${REGISTRY}/${IMAGE_NAME}:${VERSION}

if [ "$VERSION" != "latest" ]; then
  docker push ${REGISTRY}/${IMAGE_NAME}:latest
fi

echo "Done! Image pushed to ${REGISTRY}/${IMAGE_NAME}:${VERSION}"
