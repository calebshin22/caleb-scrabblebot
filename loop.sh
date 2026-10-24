#!/usr/bin/env bash
# One self-improvement cycle: scrape -> analyze -> play live matches ->
# evolve (one change, judged by eval.py) -> commit. Safe to run repeatedly;
# a lock stops overlapping runs, and a failing step doesn't stop the rest.
#
#   ./loop.sh               one cycle
#   ./loop.sh --forever     cycles until Ctrl-C
#
# Env:
#   PLAY_MINUTES=10         how long the live bot plays each cycle (0 = skip)
#   EVOLVE=auto             claude | optimize | off; auto = claude if installed
#   BOT_NAME=caleb          which .token-<name> the bot uses
set -uo pipefail
cd "$(dirname "$0")"

PLAY_MINUTES=${PLAY_MINUTES:-10}
EVOLVE=${EVOLVE:-auto}
BOT_NAME=${BOT_NAME:-caleb}
LOCK=data/.loop.lock

log() { echo "[loop $(date '+%H:%M:%S')] $*"; }

step() {
  local name=$1
  shift
  log "== $name"
  if ! "$@"; then
    log "$name failed; continuing"
    return 1
  fi
}

play() {
  [ "$PLAY_MINUTES" -gt 0 ] || { log "skipping play (PLAY_MINUTES=0)"; return 0; }
  BOT_NAME="$BOT_NAME" node --import tsx src/index.ts > data/bot-last.log 2>&1 &
  local pid=$!
  local deadline=$(( $(date +%s) + PLAY_MINUTES * 60 ))
  while kill -0 "$pid" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do sleep 5; done
  if kill -0 "$pid" 2>/dev/null; then
    kill -INT "$pid"   # lets the bot flush its match log
    wait "$pid" 2>/dev/null
  else
    wait "$pid"
    log "bot exited early (code $?); see data/bot-last.log"
    return 1
  fi
  grep -E "final:|counter '" data/bot-last.log | sed 's/^/    /' | tail -12
}

evolve() {
  local mode=$EVOLVE
  if [ "$mode" = auto ]; then
    if command -v claude >/dev/null; then mode=claude; else mode=optimize; fi
  fi
  case "$mode" in
    claude)
      claude -p "/evolve" \
        --permission-mode acceptEdits \
        --allowedTools "Read" "Edit" "Write" "Glob" "Grep" \
          "Bash(python3 eval.py:*)" "Bash(python3 optimize.py:*)" \
          "Bash(npm run typecheck)" "Bash(npm test)" \
          "Bash(git add:*)" "Bash(git commit:*)" "Bash(git checkout:*)" \
          "Bash(git diff:*)" "Bash(git log:*)" "Bash(git status)" \
        | tail -40
      ;;
    optimize) python3 optimize.py ;;
    off) log "evolve off" ;;
    *) log "unknown EVOLVE=$mode"; return 1 ;;
  esac
}

cycle() {
  mkdir -p data
  if ! mkdir "$LOCK" 2>/dev/null; then
    log "another loop holds $LOCK; exiting"
    return 0
  fi
  trap 'rmdir "$LOCK" 2>/dev/null' RETURN
  step scrape python3 scrape.py --once
  step analyze bash -c 'python3 analyze.py > /dev/null && sed -n "/## Leaderboard/,/## Biggest/p" data/report.md'
  step play play
  step evolve evolve
  # Anything evolve left uncommitted that passed (normally nothing).
  if ! git diff --quiet -- experiments.md; then
    git add experiments.md && git commit -q -m "Experiments log update" && log "committed experiments.md"
  fi
  log "cycle done; HEAD $(git log -1 --format='%h %s')"
}

trap 'rmdir "$LOCK" 2>/dev/null; exit 130' INT TERM
if [ "${1:-}" = "--forever" ]; then
  while true; do cycle; sleep 10; done
else
  cycle
fi
