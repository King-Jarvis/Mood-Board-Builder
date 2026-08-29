#!/usr/bin/env bash
#
# Mood Board Builder — auto-update.
#
# Installed beside your docker-compose.yml by install-network.sh and run on a
# schedule. Checks GitHub for a new commit on main and rebuilds the container
# only when the commit actually changes, so a poll that finds nothing new costs
# one HTTP request and nothing else.
#
# If the new build fails to answer, the previous code is restored and rebuilt.
# A broken upstream commit should not take your board offline.
#
# Run by hand any time:  bash moodboards-update.sh          (respects the SHA)
#                        bash moodboards-update.sh --force  (rebuild regardless)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/moodboards-update.env" ] && . "$HERE/moodboards-update.env"

REPO_SLUG="${REPO_SLUG:-King-Jarvis/Mood-Board-Builder}"
BRANCH="${BRANCH:-main}"
STACK_DIR="${STACK_DIR:-$HERE}"
APP_SUBDIR="${APP_SUBDIR:-moodboards-app}"
SERVICE="${SERVICE:-moodboards}"
PORT="${PORT:-8765}"

BUILD_DIR="$STACK_DIR/$APP_SUBDIR"
SHA_FILE="$BUILD_DIR/.installed-sha"
LOG="$STACK_DIR/moodboards-update.log"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else log "no docker compose available — skipping"; exit 0; fi

healthy() {
  curl -fsS -m 5 "http://127.0.0.1:$PORT/api/boards" 2>/dev/null | grep -q boards
}

# -- has anything changed? ---------------------------------------------------

REMOTE_SHA="$(curl -fsSL -m 20 \
  "https://api.github.com/repos/$REPO_SLUG/commits/$BRANCH" 2>/dev/null \
  | sed -n 's/^[[:space:]]*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' \
  | head -1)"

if [ -z "$REMOTE_SHA" ]; then
  # Offline, rate-limited, or GitHub having a moment. Not an error worth noise.
  log "could not reach GitHub — skipping this check"
  exit 0
fi

LOCAL_SHA="$(cat "$SHA_FILE" 2>/dev/null || echo none)"

if [ "$REMOTE_SHA" = "$LOCAL_SHA" ] && [ "$FORCE" -eq 0 ]; then
  # The common case. Stay quiet so the log stays readable.
  exit 0
fi

log "update: ${LOCAL_SHA:0:7} -> ${REMOTE_SHA:0:7}${FORCE:+ (forced)}"

# -- fetch -------------------------------------------------------------------

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! curl -fsSL -m 120 \
     "https://github.com/$REPO_SLUG/archive/$REMOTE_SHA.tar.gz" -o "$TMP/src.tar.gz"; then
  log "download failed — leaving the running container alone"
  exit 1
fi
tar -xzf "$TMP/src.tar.gz" -C "$TMP" || { log "bad tarball — aborting"; exit 1; }
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'Mood-Board-Builder-*' | head -1)"
if [ ! -d "${SRC:-}/moodboards" ] || [ ! -f "$SRC/docker/Dockerfile" ]; then
  log "tarball missing expected files — aborting"
  exit 1
fi

# -- swap in, keeping the old copy to fall back to ---------------------------

PREV="$BUILD_DIR.prev"
rm -rf "$PREV"
[ -d "$BUILD_DIR" ] && cp -a "$BUILD_DIR" "$PREV"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cp -R "$SRC/moodboards" "$BUILD_DIR/moodboards"
cp "$SRC/docker/Dockerfile" "$BUILD_DIR/Dockerfile"
find "$BUILD_DIR" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
printf '%s\n' "$REMOTE_SHA" > "$SHA_FILE"

# -- rebuild, and roll back if it doesn't come up ----------------------------

rollback() {
  log "ROLLING BACK to ${LOCAL_SHA:0:7}"
  rm -rf "$BUILD_DIR"
  if [ -d "$PREV" ]; then
    mv "$PREV" "$BUILD_DIR"
    (cd "$STACK_DIR" && $DC up -d --build "$SERVICE" >/dev/null 2>&1) || true
    if healthy; then log "rollback succeeded — still on ${LOCAL_SHA:0:7}"
    else log "ROLLBACK FAILED — the service is down, needs a look"; fi
  else
    log "no previous copy to roll back to — the service is down"
  fi
  exit 1
}

cd "$STACK_DIR"
if ! $DC up -d --build "$SERVICE" >> "$LOG" 2>&1; then
  log "build/start failed"
  rollback
fi

for _ in $(seq 1 40); do sleep 0.5; healthy && break; done
if ! healthy; then
  log "new build did not answer on port $PORT"
  rollback
fi

rm -rf "$PREV"
log "updated to ${REMOTE_SHA:0:7} and healthy"
