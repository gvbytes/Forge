#!/usr/bin/env bash
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
export PATH

# Open a project ONLY when one was explicitly named.
#
# This used to default to $PWD, so launching the IDE from any directory
# silently adopted it as the workspace. Started from the source checkout — the
# normal way to run it — the IDE opened its OWN source tree, and a new user was
# dropped into a file explorer full of engine/, router/, web/ with no
# indication that they had never chosen it. Worse, the engine branches per
# task, so tasks run against that accidental workspace created branches in the
# AgentZero repo itself.
#
# The engine already treats an empty root as "ask the user", and the web UI
# opens the folder picker when no root is set, so leaving this unset gives the
# intended first-run experience: pick your project, then work.
#
# Note the ${VAR-} form rather than ${VAR:-}: it substitutes only when the
# variable is UNSET, so an operator who deliberately exports an empty value
# still gets the picker instead of silently falling back.
export DEFAULT_PROJECT_ROOT="${DEFAULT_PROJECT_ROOT-}"
export PROJECT_ROOT="${PROJECT_ROOT-$DEFAULT_PROJECT_ROOT}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# ── Resolve bun robustly across PATH and standard installation paths ──
resolve_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  for p in \
    "$HOME/.bun/bin/bun" \
    "$HOME/.local/bin/bun" \
    "/opt/homebrew/bin/bun" \
    "/home/linuxbrew/.linuxbrew/bin/bun" \
    "/usr/local/bin/bun" \
    "/usr/bin/bun" \
    "$HOME/.proto/bin/bun" \
    "$HOME/.proto/shims/bun" \
    "$HOME/.cargo/bin/bun"; do
    if [ -x "$p" ]; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

BUN="$(resolve_bun || true)"
if [ -z "$BUN" ]; then
  echo "ERROR: bun not found on PATH or standard install paths." >&2
  echo "       Install bun (https://bun.sh) and retry: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi
echo "=== Using bun at: $BUN ==="

# ── Non-TTY safety: never let interactive prompts block startup ──
export CI=true

# ── Auto-install dependencies on fresh clone if node_modules is missing ──
if [ ! -d "$DIR/node_modules" ] || [ ! -d "$DIR/web/node_modules" ] || [ ! -d "$DIR/engine/node_modules" ]; then
  echo "=== Missing node_modules detected, running bun install... ==="
  (cd "$DIR" && "$BUN" install)
fi

# ── Dynamic ports: prefer documented defaults (engine 4100 / router 4098 / web 4444)
#    falling back to free ports without external distro dependencies. ──
get_port() {
  local pref="$1"
  local port=""
  if [ -f "$DIR/scripts/free-port.ts" ]; then
    port="$("$BUN" run "$DIR/scripts/free-port.ts" "$pref" 2>/dev/null || true)"
  fi
  if [ -z "$port" ] && command -v python3 >/dev/null 2>&1; then
    port="$(python3 "$DIR/scripts/free-port.py" "$pref" 2>/dev/null || true)"
  elif [ -z "$port" ] && command -v python >/dev/null 2>&1; then
    port="$(python "$DIR/scripts/free-port.py" "$pref" 2>/dev/null || true)"
  fi
  if [ -z "$port" ]; then
    port="$pref"
  fi
  echo "$port"
}

PORTS_FILE="${PORTS_FILE:-/tmp/agent-ide-ports.json}"
ENGINE_PORT="$(get_port "${ENGINE_PORT:-4100}")"
ROUTER_PORT="$(get_port "${ROUTER_PORT:-4098}")"
WEB_PORT="$(get_port "${WEB_PORT:-4444}")"
export ENGINE_PORT ROUTER_PORT WEB_PORT
printf '{"engine": %s, "router": %s, "web": %s}\n' "$ENGINE_PORT" "$ROUTER_PORT" "$WEB_PORT" > "$PORTS_FILE"
echo "=== Ports: engine=:$ENGINE_PORT router=:$ROUTER_PORT web=:$WEB_PORT (discovery: $PORTS_FILE) ==="

PIDS=()
# Kill a process and its descendant tree safely across all Linux distros and macOS
kill_tree() {
  local pid="$1"
  [ -z "$pid" ] && return
  if command -v pgrep >/dev/null 2>&1; then
    local child
    for child in $(pgrep -P "$pid" 2>/dev/null); do
      kill_tree "$child"
    done
  fi
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  echo ""
  echo "=== Shutting down Agent IDE services ==="
  for pid in "${PIDS[@]}"; do
    kill_tree "$pid"
  done
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# ── Health check helper (curl -> wget -> bun fetch) ──
check_health() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -sf -o /dev/null "$url" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q --spider "$url" 2>/dev/null
  else
    "$BUN" -e "fetch('$url').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" 2>/dev/null
  fi
}

# ── Engine first: router watchdog needs the engine reachable at boot ──
echo "=== Starting Agent Engine on :$ENGINE_PORT (Workspace: ${DEFAULT_PROJECT_ROOT:-<none — choose one in the IDE>}) ==="
cd "$DIR/engine"
# Pass the workspace through UNCHANGED. This line used to re-default it to
# $DIR — the AgentZero checkout — which silently undid the "ask the user"
# behaviour set up above and made the IDE open its own source tree. Two places
# defaulted the same variable, so fixing only one changed nothing.
DEFAULT_PROJECT_ROOT="${DEFAULT_PROJECT_ROOT-}" PROJECT_ROOT="${PROJECT_ROOT-}" \
  ENGINE_PORT="$ENGINE_PORT" \
  ENGINE_ROUTER_BASE="http://127.0.0.1:$ROUTER_PORT/v1" "$BUN" run src/index.ts &
PIDS+=($!)

# Wait for the engine health endpoint before starting the router (max ~15s)
ENGINE_UP=0
for _ in $(seq 1 30); do
  if check_health "http://127.0.0.1:$ENGINE_PORT/api/health"; then
    ENGINE_UP=1
    break
  fi
  sleep 0.5
done
if [ "$ENGINE_UP" = "1" ]; then
  echo "=== Engine is up — starting Router Proxy on :$ROUTER_PORT ==="
else
  echo "=== Engine not confirmed yet — starting Router Proxy anyway (watchdog will retry) ==="
fi

cd "$DIR/router"
PORT="$ROUTER_PORT" ENGINE_URL="http://127.0.0.1:$ENGINE_PORT" "$BUN" run src/index.ts &
PIDS+=($!)

# ── Web host binding ──────────────────────────────────────────────────────
# The Vite dev server proxies /api to the engine, so binding it to 0.0.0.0
# would tunnel the whole engine API (shell, file writes, PTY) to the LAN and
# defeat the engine's own loopback bind. Localhost by default; set
# WEB_HOST=0.0.0.0 deliberately for a demo on a trusted network.
WEB_HOST="${WEB_HOST:-127.0.0.1}"
if [ "$WEB_HOST" != "127.0.0.1" ] && [ "$WEB_HOST" != "localhost" ]; then
  echo "=== WARNING: web UI binding to $WEB_HOST — it proxies /api to the engine, so this exposes the engine to the network ==="
fi

echo "=== Starting Web IDE on :$WEB_PORT (proxying /api -> engine :$ENGINE_PORT) ==="
cd "$DIR/web"
if command -v pnpm >/dev/null 2>&1; then
  ENGINE_PORT="$ENGINE_PORT" WEB_PORT="$WEB_PORT" pnpm dev --host "$WEB_HOST" --port "$WEB_PORT" &
else
  ENGINE_PORT="$ENGINE_PORT" WEB_PORT="$WEB_PORT" "$BUN" run dev -- --host "$WEB_HOST" --port "$WEB_PORT" &
fi
PIDS+=($!)

echo ""
echo "🚀 Agent IDE is live at: http://localhost:$WEB_PORT"
echo "   engine=http://127.0.0.1:$ENGINE_PORT  router=http://127.0.0.1:$ROUTER_PORT"
echo "Press Ctrl+C to stop all services."
echo ""

# Remove trap EXIT on active wait loop so normal Ctrl+C triggers cleanup
trap cleanup SIGINT SIGTERM
while true; do
  sleep 1
done

