#!/usr/bin/env bash
set -e

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
export CI=true

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# Resolve bun robustly
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
    "/usr/bin" \
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
  exit 1
fi

echo "=== [1/5] Typecheck: web (tsc --noEmit) ==="
cd "$DIR/web"
if command -v pnpm >/dev/null 2>&1; then
  pnpm exec tsc --noEmit
else
  "$BUN" x tsc --noEmit
fi

echo "=== [2/5] Typecheck: engine (tsc --noEmit) ==="
cd "$DIR/engine"
"$BUN" x tsc --noEmit

echo "=== [3/5] Tests: router (bun test) ==="
cd "$DIR/router"
"$BUN" test

echo "=== [4/5] Tests: engine (bun test) ==="
cd "$DIR/engine"
"$BUN" test

echo "=== [5/5] Bundles ==="
cd "$DIR/web"
if command -v pnpm >/dev/null 2>&1; then
  pnpm build
else
  "$BUN" run build
fi
cd "$DIR/router" && "$BUN" build src/index.ts --target=bun --outfile=dist/router.js
cd "$DIR/engine" && "$BUN" build src/index.ts --target=bun --outfile=dist/engine.js

echo ""
echo "=== Build Complete: typechecks + tests green, artifacts in dist/ ==="
