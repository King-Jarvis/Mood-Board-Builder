#!/bin/bash
#
# Mood Board Builder — local install (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/King-Jarvis/Mood-Board-Builder/main/install/install-local.command -o ~/Downloads/install-local.command
#   bash ~/Downloads/install-local.command
#
# Fetches the code, builds a double-clickable Desktop app, starts the server
# and opens the dashboard. Safe to re-run: it updates in place and never
# touches your boards.

set -euo pipefail

REPO_URL="https://github.com/King-Jarvis/Mood-Board-Builder"
TARBALL="$REPO_URL/archive/refs/heads/main.tar.gz"

# Deliberately NOT ~/Documents, ~/Desktop or ~/Downloads: macOS TCC gates those
# and a background app cannot show the consent prompt. It fails as a confusing
# "No module named moodboards" rather than a permissions error.
INSTALL_DIR="$HOME/Mood-Board-Builder"
# The Desktop app defaults to ~/.moodboards too. If you change this, change it
# in scripts/launcher.js as well or the app and the installer will end up
# pointing at two different sets of boards.
DATA_DIR="$HOME/.moodboards"
APP="$HOME/Desktop/Mood Board Builder.app"
PORT=8765

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\n\033[31merror:\033[0m %s\n\n' "$*" >&2; exit 1; }

say "Mood Board Builder — local install"

# -- requirements ------------------------------------------------------------

[ "$(uname)" = "Darwin" ] || die "This installer is for macOS. On a server use install-network.sh."

if ! /usr/bin/python3 -V >/dev/null 2>&1; then
  die "python3 isn't available yet.
  Run:  xcode-select --install
  then run this installer again. (macOS ships the command as a stub until the
  Command Line Tools are installed.)"
fi
info "python3: $(/usr/bin/python3 -V 2>&1)"
command -v osacompile >/dev/null 2>&1 || die "osacompile is missing — it ships with macOS."

# -- fetch -------------------------------------------------------------------

say "Fetching the latest code"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$TARBALL" -o "$TMP/main.tar.gz" \
  || die "Couldn't download from GitHub. Check your connection, and that
  $REPO_URL is reachable."
tar -xzf "$TMP/main.tar.gz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'Mood-Board-Builder-*' | head -1)"
[ -d "$SRC/moodboards" ] || die "The download didn't contain the expected files."
info "downloaded $(du -sh "$SRC" | cut -f1)"

# Replace only the code. Anything else in the install dir is left alone.
mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR/moodboards"
cp -R "$SRC/moodboards" "$INSTALL_DIR/moodboards"
mkdir -p "$INSTALL_DIR/scripts"
cp -R "$SRC/scripts/." "$INSTALL_DIR/scripts/" 2>/dev/null || true
cp "$SRC/README.md" "$INSTALL_DIR/README.md" 2>/dev/null || true
info "installed to $INSTALL_DIR"

mkdir -p "$DATA_DIR"
info "data lives in $DATA_DIR (kept across updates)"

# -- desktop app -------------------------------------------------------------

say "Building the Desktop app"
LAUNCHER="$INSTALL_DIR/scripts/launcher.js"
[ -f "$LAUNCHER" ] || die "launcher.js missing from the download."

rm -rf "$APP"
osacompile -l JavaScript -o "$APP" "$LAUNCHER" \
  || die "osacompile failed to build the app."
if [ -f "$INSTALL_DIR/scripts/launcher-icon.icns" ]; then
  cp "$INSTALL_DIR/scripts/launcher-icon.icns" "$APP/Contents/Resources/applet.icns"
fi
/usr/libexec/PlistBuddy -c "Set :CFBundleName Mood Board Builder" \
  "$APP/Contents/Info.plist" >/dev/null 2>&1 || true
# Background app: no menu bar, no Dock icon while it runs.
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" \
  "$APP/Contents/Info.plist" >/dev/null 2>&1 || true
touch "$APP"
info "built $APP"

# -- start it ----------------------------------------------------------------

say "Starting the dashboard"

already() { curl -fsS -m 2 "http://127.0.0.1:$PORT/api/boards" 2>/dev/null | grep -q boards; }

if already; then
  info "already running on port $PORT"
else
  cd "$INSTALL_DIR"
  nohup /usr/bin/python3 -u -m moodboards --port "$PORT" --data "$DATA_DIR" \
    >> /tmp/mood-board-builder.out 2>&1 &
  for _ in $(seq 1 30); do sleep 0.4; already && break; done
fi

if already; then
  info "serving at http://127.0.0.1:$PORT"
  open "http://127.0.0.1:$PORT" || true
else
  die "The server didn't come up. Last output:
$(tail -n 12 /tmp/mood-board-builder.out 2>/dev/null || echo '  (none)')"
fi

say "Done"
cat <<EOF
  Dashboard   http://127.0.0.1:$PORT
  App         double-click "Mood Board Builder" on your Desktop
  Boards      $DATA_DIR   (yours; back this up)
  Code        $INSTALL_DIR
  Logs        $DATA_DIR/moodboards.log

  Re-run this installer any time to update. Your boards are untouched.
EOF
