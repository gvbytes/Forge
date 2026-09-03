#!/usr/bin/env bash
# Master launcher: Agent Engine (:4100), Router (:4098), Web IDE (:4444).
# ZERO hardcoded paths: everything resolves from THIS file's real location, so
# the repo can be cloned, moved, renamed or symlinked anywhere and launched
# from any working directory. Runs under bash or sh.
set -eu

# ── Resolve this script's real directory: CWD-independent + symlink-safe ──
# (a launcher symlinked into ~/bin must still find the repo it lives in)
SELF="${BASH_SOURCE:-$0}"
while [ -L "$SELF" ]; do
  TARGET="$(readlink "$SELF")"
  case "$TARGET" in
    /*) SELF="$TARGET" ;;
    *)  SELF="$(dirname -- "$SELF")/$TARGET" ;;
  esac
done
SCRIPT_DIR="$(cd -- "$(dirname -- "$SELF")" && pwd -P)"

DEV="$SCRIPT_DIR/scripts/dev.sh"
if [ ! -f "$DEV" ]; then
  echo "ERROR: scripts/dev.sh not found at: $DEV" >&2
  echo "       Expected repo layout: <repo>/start.sh + <repo>/scripts/dev.sh." >&2
  exit 1
fi

# Free default ports (4100, 4098, 4444) if held by stale processes
if [ -f "$SCRIPT_DIR/scripts/port-kill.py" ] && command -v python3 >/dev/null 2>&1; then
  python3 "$SCRIPT_DIR/scripts/port-kill.py" >/dev/null 2>&1 || true
fi

# Extend PATH with standard binary locations across distros and macOS
for p in \
  "$HOME/.local/bin" \
  "$HOME/.bun/bin" \
  "$HOME/.cargo/bin" \
  "$HOME/.proto/bin" \
  "$HOME/.proto/shims" \
  "/opt/homebrew/bin" \
  "/opt/homebrew/sbin" \
  "/home/linuxbrew/.linuxbrew/bin" \
  "/usr/local/bin" \
  "/usr/local/sbin" \
  "/usr/bin" \
  "/bin"; do
  if [ -d "$p" ] && [[ ":$PATH:" != *":$p:"* ]]; then
    PATH="$p:$PATH"
  fi
done
# ── Capture workspace folder: CLI arg ($1) > caller's active terminal CWD ──
# (like agy/code/cursor: opens the directory from which the command was invoked)
CALLER_CWD="$PWD"
TARGET_DIR="${1:-$CALLER_CWD}"
if [ -d "$TARGET_DIR" ]; then
  TARGET_DIR="$(cd "$TARGET_DIR" && pwd -P)"
else
  TARGET_DIR="$CALLER_CWD"
fi
export DEFAULT_PROJECT_ROOT="$TARGET_DIR"
export PROJECT_ROOT="$TARGET_DIR"

exec bash "$DEV" "$@"
