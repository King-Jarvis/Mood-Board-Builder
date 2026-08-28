#!/usr/bin/env bash
#
# Mood Board Builder — network install (Linux / NAS).
#
#   curl -fsSL https://raw.githubusercontent.com/King-Jarvis/Mood-Board-Builder/main/install/install-network.sh -o install-network.sh
#   bash install-network.sh
#
# Fetches the code, adds a `moodboards` service to your docker-compose.yml,
# builds and starts it. The dashboard is then reachable at this host's address.
#
# Safe to re-run: the compose file is backed up and validated before anything
# is started, and the service block is only added once.

set -euo pipefail

REPO_URL="https://github.com/King-Jarvis/Mood-Board-Builder"
TARBALL="$REPO_URL/archive/refs/heads/main.tar.gz"

STACK_DIR="${STACK_DIR:-$PWD}"          # where docker-compose.yml lives
APP_SUBDIR="moodboards-app"             # build context, beside the compose file
DATA_SUBDIR="moodboards-data"           # bind-mounted at /data
SERVICE="moodboards"
PORT="${PORT:-8765}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31merror:\033[0m %s\n\n' "$*" >&2; exit 1; }

say "Mood Board Builder — network install"

# -- requirements ------------------------------------------------------------

command -v curl >/dev/null 2>&1 || die "curl is required."
command -v tar  >/dev/null 2>&1 || die "tar is required."
command -v docker >/dev/null 2>&1 || die "docker is required but not installed."

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "Neither 'docker compose' nor 'docker-compose' is available."
fi
docker info >/dev/null 2>&1 || die "The Docker daemon isn't reachable. Start Docker, or run this with sudo."
info "docker: $(docker --version | sed 's/,.*//')"
info "compose: $DC"

# -- where is the stack? -----------------------------------------------------

COMPOSE=""
for candidate in "$STACK_DIR/docker-compose.yml" "$STACK_DIR/docker-compose.yaml" \
                 "$STACK_DIR/compose.yml" "$STACK_DIR/compose.yaml"; do
  [ -f "$candidate" ] && { COMPOSE="$candidate"; break; }
done

if [ -z "$COMPOSE" ]; then
  warn "No compose file in $STACK_DIR — creating one."
  COMPOSE="$STACK_DIR/docker-compose.yml"
  printf 'services:\n' > "$COMPOSE"
fi
info "compose file: $COMPOSE"
info "stack dir:    $STACK_DIR"

# -- fetch -------------------------------------------------------------------

say "Fetching the latest code"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$TARBALL" -o "$TMP/main.tar.gz" \
  || die "Couldn't download from GitHub. Check the host's connection and that
  $REPO_URL is reachable."
tar -xzf "$TMP/main.tar.gz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'Mood-Board-Builder-*' | head -1)"
[ -d "$SRC/moodboards" ] || die "The download didn't contain the expected files."

BUILD_DIR="$STACK_DIR/$APP_SUBDIR"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cp -R "$SRC/moodboards" "$BUILD_DIR/moodboards"
cp "$SRC/docker/Dockerfile" "$BUILD_DIR/Dockerfile"
find "$BUILD_DIR" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
info "build context: $BUILD_DIR ($(du -sh "$BUILD_DIR" | cut -f1))"

mkdir -p "$STACK_DIR/$DATA_SUBDIR"
info "data dir:      $STACK_DIR/$DATA_SUBDIR (yours; back this up)"

# -- add the service ---------------------------------------------------------

say "Wiring it into compose"

if grep -qE "^[[:space:]]*${SERVICE}:[[:space:]]*$" "$COMPOSE"; then
  info "service '$SERVICE' already present — leaving the compose file alone"
else
  BACKUP="$COMPOSE.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$COMPOSE" "$BACKUP"
  info "backed up to $BACKUP"

  grep -qE '^[[:space:]]*services:[[:space:]]*$' "$COMPOSE" || printf '\nservices:\n' >> "$COMPOSE"

  # Match the indentation the file already uses for its services, so the block
  # lands consistently whether the file indents by 2 spaces or 4.
  INDENT="$(awk '
    /^[[:space:]]*services:[[:space:]]*$/ { inserv=1; next }
    inserv && /^[[:space:]]+[A-Za-z0-9_.-]+:[[:space:]]*$/ {
      match($0, /^[[:space:]]+/); print substr($0, 1, RLENGTH); exit
    }' "$COMPOSE")"
  [ -n "$INDENT" ] || INDENT="  "

  {
    printf '\n'
    printf '%s%s:\n'                    "$INDENT" "$SERVICE"
    printf '%s  build:\n'               "$INDENT"
    printf '%s    context: ./%s\n'      "$INDENT" "$APP_SUBDIR"
    printf '%s    dockerfile: Dockerfile\n' "$INDENT"
    printf '%s  container_name: %s\n'   "$INDENT" "$SERVICE"
    printf '%s  ports:\n'               "$INDENT"
    printf '%s    - "%s:8765"\n'        "$INDENT" "$PORT"
    printf '%s  environment:\n'         "$INDENT"
    printf '%s    - MOODBOARDS_DATA=/data\n' "$INDENT"
    printf '%s  volumes:\n'             "$INDENT"
    printf '%s    - ./%s:/data\n'       "$INDENT" "$DATA_SUBDIR"
    printf '%s  restart: unless-stopped\n' "$INDENT"
  } >> "$COMPOSE"

  # Validate before starting anything; roll back rather than leave it broken.
  if ! (cd "$STACK_DIR" && $DC config -q >/dev/null 2>&1); then
    cp "$BACKUP" "$COMPOSE"
    die "Adding the service made the compose file invalid, so it was restored
  from $BACKUP. Add this block by hand under 'services:':

${INDENT}${SERVICE}:
${INDENT}  build:
${INDENT}    context: ./${APP_SUBDIR}
${INDENT}    dockerfile: Dockerfile
${INDENT}  container_name: ${SERVICE}
${INDENT}  ports:
${INDENT}    - \"${PORT}:8765\"
${INDENT}  volumes:
${INDENT}    - ./${DATA_SUBDIR}:/data
${INDENT}  restart: unless-stopped"
  fi
  info "added service '$SERVICE' (compose file validates)"
fi

# -- build and start ---------------------------------------------------------

say "Building and starting"
cd "$STACK_DIR"
$DC up -d --build "$SERVICE" || die "docker compose failed. See: $DC logs $SERVICE"

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "${HOST_IP:-}" ] || HOST_IP="$(hostname -i 2>/dev/null | awk '{print $1}')" || true
[ -n "${HOST_IP:-}" ] || HOST_IP="this-host"

for _ in $(seq 1 30); do
  sleep 0.5
  curl -fsS -m 2 "http://127.0.0.1:$PORT/api/boards" 2>/dev/null | grep -q boards && break
done

if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/boards" 2>/dev/null | grep -q boards; then
  info "responding on port $PORT"
else
  warn "not responding yet — check: $DC logs $SERVICE"
fi

say "Done"
cat <<EOF
  Dashboard   http://$HOST_IP:$PORT
  Boards      $STACK_DIR/$DATA_SUBDIR   (yours; back this up)
  Code        $BUILD_DIR
  Logs        $DC logs -f $SERVICE

  Update later by re-running this installer, then:
      cd $STACK_DIR && $DC up -d --build $SERVICE

  !! There is no login. Anyone who can reach http://$HOST_IP:$PORT can view,
     edit and permanently delete every board. That is fine on a trusted LAN.
     If you put a reverse proxy in front of it on a public hostname, add an
     access list there.
EOF
