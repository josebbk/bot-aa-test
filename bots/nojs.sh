#!/usr/bin/env bash
# bot-nojs: plain curl GET requests. No JavaScript runs, so PostHog never loads.
set -euo pipefail
cd "$(dirname "$0")/.."

COUNT=50
URL="https://josebbk.github.io/bot-aa-test/"
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --count) COUNT="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "Unknown option: $1" >&2; echo "Usage: [--count N] [--url URL] [--dry-run]" >&2; exit 1 ;;
  esac
done

if [ "$DRY" = 1 ]; then
  URL_FILE="$(mktemp)"
  node bots/serve.mjs > "$URL_FILE" &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null; rm -f "$URL_FILE"' EXIT
  for _ in $(seq 50); do [ -s "$URL_FILE" ] && break; sleep 0.1; done
  URL="$(head -n1 "$URL_FILE")"
fi

case "$URL" in *\?*) TARGET="${URL}&g=bot-nojs" ;; *) TARGET="${URL}?g=bot-nojs" ;; esac
UA="curl/$(curl --version | head -n1 | cut -d' ' -f2)"
LOG="logs/visits.csv"
mkdir -p logs
[ -f "$LOG" ] || echo "timestamp,group,visit,user_agent,clicked,http_status,variant,target_url" > "$LOG"

echo "bot-nojs: $COUNT visit(s) to $TARGET$([ "$DRY" = 1 ] && echo '  [dry run]')"
for i in $(seq 1 "$COUNT"); do
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -A "$UA" "$TARGET" || true)"
  printf '%s,bot-nojs,%s,"%s",false,%s,,"%s"\n' "$TS" "$i" "$UA" "$STATUS" "$TARGET" >> "$LOG"
  echo "  #$i status=$STATUS"
  if [ "$i" -lt "$COUNT" ]; then
    sleep "$(awk -v r="$RANDOM" 'BEGIN { printf "%.2f", 0.5 + r / 32767 * 1.5 }')"
  fi
done
echo "Logged to $LOG"
