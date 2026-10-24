#!/usr/bin/env bash
# Keep the bot running: restart it 3 s after it exits for any reason.
# Stop with Ctrl-C twice (once for the bot, once for this loop).
cd "$(dirname "$0")"
while true; do
  npm start
  sleep 3
done
