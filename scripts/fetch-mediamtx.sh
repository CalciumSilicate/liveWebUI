#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-1.17.1}"
ARCH_RAW="${MEDIAMTX_ARCH:-$(uname -m)}"

case "$ARCH_RAW" in
  x86_64|amd64)
    ARCH="amd64"
    ;;
  aarch64|arm64)
    ARCH="arm64"
    ;;
  armv7l|armv7)
    ARCH="armv7"
    ;;
  armv6l|armv6)
    ARCH="armv6"
    ;;
  *)
    echo "Unsupported architecture: $ARCH_RAW" >&2
    exit 1
    ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$ROOT_DIR/vendor/mediamtx"
TMP_DIR="$(mktemp -d)"
ASSET="mediamtx_v${VERSION}_linux_${ARCH}.tar.gz"
URL="https://github.com/bluenviron/mediamtx/releases/download/v${VERSION}/${ASSET}"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TARGET_DIR"

curl -fsSL "$URL" -o "$TMP_DIR/mediamtx.tar.gz"
rm -rf "$TARGET_DIR"/*
tar -xzf "$TMP_DIR/mediamtx.tar.gz" -C "$TARGET_DIR"
printf '%s\n' "$VERSION" > "$TARGET_DIR/VERSION"
printf '%s\n' "$ARCH" > "$TARGET_DIR/ARCH"

echo "Fetched MediaMTX v${VERSION} for ${ARCH} into $TARGET_DIR"
