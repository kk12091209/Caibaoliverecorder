#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
MODE="${1:---verify}"
source "$ROOT/live-editor/scripts/dev-env.sh"
# Use isolated development data. A production instance is never killed.
export CAIBO_DATA_ROOT="$ROOT/.tools/macos-development/data"
export CAIBO_EXPORT_ROOT="$ROOT/.tools/macos-development/exports"
mkdir -p "$CAIBO_DATA_ROOT"
if [[ -f "$CAIBO_DATA_ROOT/desktop-service.json" ]]; then
  node "$ROOT/live-editor/scripts/stop-macos-dev.mjs" "$CAIBO_DATA_ROOT" --check
fi
# Ask the previous development window to close via macOS termination handling;
# do not pkill another installation that may be recording.
if [[ -f "$ROOT/.tools/macos-last-app.txt" ]]; then
  old=$(cat "$ROOT/.tools/macos-last-app.txt")
  if [[ -d "$old" ]]; then
    osascript - "$old" <<'APPLESCRIPT'
on run argv
  if application (item 1 of argv) is running then
    try
      tell application (item 1 of argv) to quit
    on error message number code
      -- The desktop defers termination while it safely shuts down its backend.
      -- macOS reports that asynchronous termination as "user cancelled".
      if code is not -128 then error message number code
    end try
  end if
end run
APPLESCRIPT
  fi
fi
sleep 1
if [[ -f "$CAIBO_DATA_ROOT/desktop-service.json" ]]; then
  node "$ROOT/live-editor/scripts/stop-macos-dev.mjs" "$CAIBO_DATA_ROOT"
fi
OUTPUT="$ROOT/.tools/macos-build-$(date +%Y%m%d-%H%M%S)"
"$ROOT/live-editor/scripts/build-macos.sh" "$OUTPUT"
APP="$OUTPUT/菜播·录包机.app"
printf '%s' "$APP" > "$ROOT/.tools/macos-last-app.txt"
case "$MODE" in
  --debug) lldb -- "$APP/Contents/MacOS/CaiboDesktop" ;;
  --verify|run|--logs|--telemetry)
    open -n --env "CAIBO_DATA_ROOT=$CAIBO_DATA_ROOT" --env "CAIBO_EXPORT_ROOT=$CAIBO_EXPORT_ROOT" "$APP"
    if [[ "$MODE" == --verify ]]; then sleep 2; pgrep -x CaiboDesktop >/dev/null; fi
    if [[ "$MODE" == --logs || "$MODE" == --telemetry ]]; then /usr/bin/log stream --info --style compact --predicate 'process == "CaiboDesktop"'; fi
    ;;
  *) echo 'Usage: build_and_run.sh [run|--verify|--debug|--logs|--telemetry]' >&2; exit 2 ;;
esac
