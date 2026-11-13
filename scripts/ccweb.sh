#!/usr/bin/env bash
# Restart a cc-web instance.
#
#   scripts/ccweb.sh [port]                  restart the checkout this script lives in
#   CCWEB_REMOTE=1 scripts/ccweb.sh [port]   run the remote host's copy over ssh
#   CCWEB_AUTH=xxx                           write/rotate the token first
#
# No absolute paths are baked in: the checkout is located from this script
# (<checkout>/scripts/ccweb.sh), so moving the checkout keeps it working.
#
# Per-machine settings go in ~/.cc-web/ccweb.env (optional, sourced). Write
# them as `: "${VAR:=value}"` so a variable set on the command line still wins:
#   CCWEB_PLANS_DIR      --plans-dir, comma-separated   (default: <checkout>/../.claude/plans)
#   CCWEB_SSH            user@host for CCWEB_REMOTE=1
#   CCWEB_REMOTE_SCRIPT  path of this script on that host
#   CCWEB_AUTH_FILE, CCWEB_LOG, CCW_DATA_DIR   override the per-port defaults below
#
# Everything an instance owns lives under ~/.cc-web/ (0700):
#   token-<port>  data-<port>/  <port>.log
set -eu
PORT="${1:-32352}"

BASE="$HOME/.cc-web"
CONF="${CCWEB_CONF:-$BASE/ccweb.env}"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

if [ "${CCWEB_REMOTE:-}" = "1" ]; then
  [ -n "${CCWEB_SSH:-}" ] && [ -n "${CCWEB_REMOTE_SCRIPT:-}" ] || {
    echo "CCWEB_REMOTE=1 needs CCWEB_SSH and CCWEB_REMOTE_SCRIPT (set them in $CONF)" >&2; exit 1; }
  [ -z "${CCWEB_AUTH_FILE:-}" ] || { echo "CCWEB_AUTH_FILE is local-only; use CCWEB_AUTH=..." >&2; exit 1; }
  exec ssh "$CCWEB_SSH" "CCWEB_AUTH='${CCWEB_AUTH:-}' '$CCWEB_REMOTE_SCRIPT' $*"
fi

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
PLANS_DIR="${CCWEB_PLANS_DIR:-$(dirname "$PROJECT")/.claude/plans}"
command -v node >/dev/null 2>&1 || PATH="$HOME/.local/share/mise/shims:$PATH"

mkdir -p "$BASE"
chmod 700 "$BASE" 2>/dev/null || true
TOKEN_FILE="${CCWEB_AUTH_FILE:-$BASE/token-$PORT}"
LOG="${CCWEB_LOG:-$BASE/$PORT.log}"
# One data dir per port: two instances sharing one corrupt each other's sessions.
export CCW_DATA_DIR="${CCW_DATA_DIR:-$BASE/data-$PORT}"

echo "==> restarting cc-web on :$PORT  ($PROJECT)"

# Stop the old instance, then reap claude hooks orphaned by it.
OLD=$(lsof -ti:"$PORT" 2>/dev/null || true)
if [ -n "$OLD" ]; then
  kill $OLD 2>/dev/null || true
  sleep 1
  lsof -ti:"$PORT" >/dev/null 2>&1 && { kill -9 $(lsof -ti:"$PORT") 2>/dev/null || true; sleep 1; }
fi
pkill -f "cc-hook.js' --port $PORT" 2>/dev/null || true

# Token in a 0600 file, never on the command line. It is an admin credential
# (it creates the first admin and is accepted as one), so a missing file gets
# a random one, never a fixed default; an existing file is left as it is.
if [ -n "${CCWEB_AUTH:-}" ]; then
  ( umask 077; printf '%s\n' "$CCWEB_AUTH" > "$TOKEN_FILE" )
elif [ ! -f "$TOKEN_FILE" ]; then
  NEW_TOKEN="$(openssl rand -hex 24 2>/dev/null || od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  [ -n "$NEW_TOKEN" ] || { echo "could not generate a token" >&2; exit 1; }
  ( umask 077; printf '%s\n' "$NEW_TOKEN" > "$TOKEN_FILE" )
  echo "    generated a token in $TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE" 2>/dev/null || true

( cd "$PROJECT" && nohup node bin/cc-web.js --no-open --port "$PORT" \
    --auth-file "$TOKEN_FILE" --plans-dir "$PLANS_DIR" >> "$LOG" 2>&1 < /dev/null & )

for i in $(seq 1 15); do
  H=$(curl -s -m 2 -H "Authorization: Bearer $(head -n1 "$TOKEN_FILE")" "http://127.0.0.1:$PORT/api/health" || true)
  [ -n "$H" ] && { echo "    ok: $H"; exit 0; }
  sleep 1
done
echo "    not responding after 15s — see $LOG" >&2
exit 1
