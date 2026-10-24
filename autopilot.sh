#!/usr/bin/env bash
# Hands-off improvement: keeps cortado playing live, and every CYCLE_MINUTES
# scrapes new matches, refreshes the report, opponent profiles and market
# prices, and runs one evolve_live.py step (promote / retire / spawn
# strategy variants from live results). Each change is committed.
#
#   BOT_NAME=caleb ./autopilot.sh          (stop with Ctrl-C)
#
# The bot reloads strategy.json at every match start, so changes apply
# without restarts. Use this instead of loop.sh for live play; loop.sh
# starts its own bot.
set -uo pipefail
cd "$(dirname "$0")"

CYCLE_MINUTES=${CYCLE_MINUTES:-30}
BOT_NAME=${BOT_NAME:-caleb}
LOCK=data/.autopilot.lock
mkdir -p data

log() { echo "[autopilot $(date '+%H:%M:%S')] $*"; }

if ! mkdir "$LOCK" 2>/dev/null; then
  log "another autopilot holds $LOCK; exiting"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null; exit 130' INT TERM
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

ensure_bot() {
  if ! pgrep -f "run.sh" >/dev/null; then
    log "starting the bot"
    BOT_NAME="$BOT_NAME" nohup ./run.sh >> data/run.log 2>&1 &
  fi
}

cycle=0
while true; do
  cycle=$((cycle + 1))
  ensure_bot
  log "scrape";  nice -n 10 python3 scrape.py --once || log "scrape failed"
  log "analyze"; nice -n 10 python3 analyze.py > /dev/null || log "analyze failed"
  sed -n '/## Leaderboard/,/## Results/p' data/report.md | grep -E '^- ' | sed 's/^/    /'
  log "price model"; nice -n 10 python3 price_model.py || log "price model failed"
  log "evolve";  python3 evolve_live.py || log "evolve failed"
  # Every 4th cycle (~2 h): re-tune against real opponents' bids in our
  # recent matches, and refresh the replay_best live variant.
  if [ $((cycle % 4)) -eq 0 ]; then
    log "replay search"; python3 replay_spawn.py || log "replay search failed"
  fi
  python3 live_eval.py | tail -6 | sed 's/^/    /'
  # Keep GitHub in sync; main tracks the working branch.
  git branch -f main HEAD 2>/dev/null
  GIT_TERMINAL_PROMPT=0 git push -q origin HEAD main 2>&1 | tail -1 || log "push failed"
  log "sleeping ${CYCLE_MINUTES}m"
  sleep $((CYCLE_MINUTES * 60))
done
