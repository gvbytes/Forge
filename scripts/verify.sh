#!/usr/bin/env bash
# Wave-3 integration verification: boots all three services via scripts/dev.sh
# (which picks FREE ports dynamically and writes them to $PORTS_FILE), then
# exercises the fixed contract end-to-end against those ports. Run from anywhere.
set -u
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

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG=/tmp/agent-ide-verify.log
export PORTS_FILE="${PORTS_FILE:-/tmp/agent-ide-ports.json}"
PASS=0; FAIL=0
ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
check() { # check <desc> <cmd...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi
}

echo "=== 1. Booting services (scripts/dev.sh, dynamic ports) ==="
rm -f "$PORTS_FILE"
bash "$DIR/scripts/dev.sh" >"$LOG" 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null || true' EXIT

# dev.sh writes the chosen ports to $PORTS_FILE before serving; wait for it.
for i in $(seq 1 40); do [ -s "$PORTS_FILE" ] && break; sleep 0.5; done

read_port() {
  local key="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json;print(json.load(open("'"$PORTS_FILE"'"))["'"$key"'"])' 2>/dev/null || true
  elif command -v bun >/dev/null 2>&1; then
    bun -e 'console.log(require("'"$PORTS_FILE"'")["'"$key"'"])' 2>/dev/null || true
  fi
}

EP=$(read_port "engine")
RP=$(read_port "router")
WP=$(read_port "web")
if [ -z "${EP:-}" ] || [ -z "${RP:-}" ] || [ -z "${WP:-}" ]; then
  echo "  ✗ could not read chosen ports from $PORTS_FILE"; echo "VERIFY RESULT: aborted"; exit 1
fi
echo "  discovered ports: engine=$EP router=$RP web=$WP"

for i in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$EP/api/health" && \
  curl -sf -o /dev/null "http://127.0.0.1:$RP/health" && \
  curl -sf -o /dev/null "http://127.0.0.1:$WP/" && break
  sleep 1
done

echo "=== 2. Health ==="
check "engine /api/health 200"  curl -sf "http://127.0.0.1:$EP/api/health"
check "router /health 200"      curl -sf "http://127.0.0.1:$RP/health"
check "web :$WP serves"         curl -sf "http://127.0.0.1:$WP/"

echo "=== 3. Previously-404 endpoints (B18) ==="
check "POST /api/bytheway exists (not 404)" bash -c '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:'"$EP"'/api/bytheway -H "Content-Type: application/json" -d "{\"text\":\"ping\"}")" != "404" ]'
check "GET /api/index/status 200" curl -sf "http://127.0.0.1:$EP/api/index/status"
check "GET /api/websearch exists (not 404)" bash -c '[ "$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:'"$EP"'/api/websearch?query=test")" != "404" ]'

echo "=== 4. Settings masking (B25) ==="
if curl -s "http://127.0.0.1:$EP/api/settings" | grep -q '"apiKey":"••••••••"\|"api_key":"••••••••"'; then
  ok "api keys masked in GET /api/settings"
elif curl -s "http://127.0.0.1:$EP/api/settings" | grep -Eq '"(apiKey|api_key)":"sk-'; then
  bad "RAW api key leaked in GET /api/settings"
else
  ok "no raw api keys present (none configured)"
fi

echo "=== 5. Task lifecycle + event contract (B1/B3/B4/B19) ==="
TASK_RESP=$(curl -s -X POST "http://127.0.0.1:$EP/api/tasks" -H "Content-Type: application/json" \
  -d '{"prompt":"Say hello and nothing else.","path":"'"$DIR"'"}')
echo "  task response: $TASK_RESP"
TASK_ID=$(echo "$TASK_RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("taskId",""))' 2>/dev/null)
SESS_ID=$(echo "$TASK_RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("sessionId",""))' 2>/dev/null)
if [ -n "$TASK_ID" ] && [ "$TASK_ID" != "$SESS_ID" ]; then ok "POST /api/tasks returns real task UUID distinct from sessionId (B19)"; else bad "task identity: taskId='$TASK_ID' sessionId='$SESS_ID'"; fi

# poll for completion (max ~180s)
STATUS=""
for i in $(seq 1 90); do
  STATUS=$(curl -s "http://127.0.0.1:$EP/api/tasks" | python3 -c '
import sys,json
try:
  rows=json.load(sys.stdin)
  for t in rows:
    if t.get("id")=="'"$TASK_ID"'" or t.get("sessionId")=="'"$SESS_ID"'":
      print(t.get("status","")); break
except Exception: pass' 2>/dev/null)
  case "$STATUS" in done|failed|stopped) break;; esac
  sleep 2
done
echo "  final status: $STATUS"
[ "$STATUS" = "done" ] && ok "task reached done" || bad "task status '$STATUS' (wanted done)"

EVENTS=$(curl -s "http://127.0.0.1:$EP/api/tasks/$TASK_ID/events")
echo "$EVENTS" | python3 -c '
import sys, json
evs = json.load(sys.stdin)
assert isinstance(evs, list) and evs, "no events"
ids = [e.get("id") for e in evs]
assert all(isinstance(i, (int, float)) for i in ids), "non-numeric ids"
assert ids == sorted(ids), "ids not ascending"
types = {e.get("type") for e in evs}
kinds = {e.get("payload", {}).get("event", {}).get("kind") for e in evs if e.get("type") == "trace"}
assert "message" in types, "no message events (B3 broken: conversation lost on reload)"
assert kinds & {"tool.call", "llm.call"}, f"no tool.call/llm.call trace events (B1/B2 broken): {kinds}"
print("  events:", len(evs), "types:", sorted(t for t in types if t), "kinds:", sorted(k for k in kinds if k))
' && ok "event contract: single id space, messages + traces replayed (B1/B3/B4)" || bad "event contract check failed"

SINCE=$(echo "$EVENTS" | python3 -c 'import sys,json;evs=json.load(sys.stdin);print(evs[len(evs)//2]["id"])' 2>/dev/null)
N_ALL=$(echo "$EVENTS" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
N_SINCE=$(curl -s "http://127.0.0.1:$EP/api/tasks/$TASK_ID/events?since=$SINCE" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null)
if [ -n "$N_SINCE" ] && [ "$N_SINCE" -lt "$N_ALL" ]; then ok "?since= honored ($N_SINCE < $N_ALL)"; else bad "?since= ignored (got $N_SINCE of $N_ALL)"; fi

echo "=== 6. Watchdog sees the engine (B8) ==="
WD=$(curl -s "http://127.0.0.1:$RP/watchdog/status")
echo "  watchdog: $WD"
SIGNALS=$(echo "$WD" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("totals",{}).get("signals",0))' 2>/dev/null)
ATTACHED=$(echo "$WD" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("attached",False))' 2>/dev/null)
LASTSESS=$(echo "$WD" | python3 -c 'import sys,json;print((json.load(sys.stdin).get("lastActiveSession") or {}).get("sessionID",""))' 2>/dev/null)
[ "$ATTACHED" = "True" ] && ok "watchdog attached" || bad "watchdog not attached"
# totals.signals counts STUCK-detection interventions (repeat/error tool calls), which
# a healthy task may never produce. The definitive proof the router ingested a live
# engine frame is lastActiveSession being set (attribution.observe on a parsed frame).
if [ -n "$LASTSESS" ] || [ "${SIGNALS:-0}" != "0" ]; then
  ok "watchdog sees engine frames (B8): lastActiveSession='$LASTSESS' signals=$SIGNALS"
else
  bad "watchdog saw no engine frames (B8 still blind): lastActiveSession empty, signals=0"
fi

echo "=== 7. Router /models discovery shape (B41) ==="
curl -s "http://127.0.0.1:$RP/models" | python3 -c '
import sys, json
d = json.load(sys.stdin)
# router /models is OpenAI-style: { object:"list", data:[{id,...}] }
models = d.get("data") if isinstance(d, dict) else d
if not isinstance(models, list):
    models = d.get("models", []) if isinstance(d, dict) else []
ids = [m.get("id") for m in models if isinstance(m, dict)]
assert ids and all(i for i in ids), f"models missing ids: {ids[:5]}"
print("  models with ids:", len(ids))
' && ok "/models emits real ids (B41)" || bad "/models ids broken (B41)"

echo ""
echo "============================================"
echo "  VERIFY RESULT: $PASS passed, $FAIL failed"
echo "  ports: engine=$EP router=$RP web=$WP  log: $LOG"
echo "============================================"
[ "$FAIL" = "0" ]
