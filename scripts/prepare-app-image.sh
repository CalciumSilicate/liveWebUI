#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/vendor/node-runtime"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
NPM_BIN="${NPM_BIN:-$(command -v npm)}"
FFMPEG_BIN="${FFMPEG_BIN:-$(command -v ffmpeg || true)}"
FFPROBE_BIN="${FFPROBE_BIN:-$(command -v ffprobe || true)}"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "node not found" >&2
  exit 1
fi

if [[ -z "$NPM_BIN" || ! -x "$NPM_BIN" ]]; then
  echo "npm not found" >&2
  exit 1
fi

copy_with_parents() {
  local path="$1"
  if [[ -e "$path" ]]; then
    mkdir -p "$RUNTIME_DIR"
    cp -L --parents "$path" "$RUNTIME_DIR"
  fi
}

collect_runtime_deps() {
  local target="$1"
  ldd "$target" 2>/dev/null | grep -o '/[^ ]*' | while read -r lib; do
    copy_with_parents "$lib"
  done
}

cd "$ROOT_DIR"

"$NPM_BIN" ci
"$NPM_BIN" run build
"$NPM_BIN" prune --omit=dev

rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"

copy_with_parents "$NODE_BIN"
collect_runtime_deps "$NODE_BIN"
if [[ -n "$FFMPEG_BIN" && -x "$FFMPEG_BIN" ]]; then
  copy_with_parents "$FFMPEG_BIN"
  collect_runtime_deps "$FFMPEG_BIN"
fi
if [[ -n "$FFPROBE_BIN" && -x "$FFPROBE_BIN" ]]; then
  copy_with_parents "$FFPROBE_BIN"
  collect_runtime_deps "$FFPROBE_BIN"
fi

while IFS= read -r native_module; do
  collect_runtime_deps "$native_module"
done < <(find "$ROOT_DIR/node_modules" -type f -name '*.node' | sort)

if [[ -f /etc/ssl/certs/ca-certificates.crt ]]; then
  copy_with_parents /etc/ssl/certs/ca-certificates.crt
fi

echo "Prepared app image context with host node runtime:"
echo "  node: $NODE_BIN"
echo "  runtime dir: $RUNTIME_DIR"
