#!/usr/bin/env bash
set -u

cd "$(dirname "$0")" || exit 1

while true; do
  printf '\n[%s] starting biteagle poller\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  node biteagle_news_feed.mjs --mode poll --interval-ms 15000 --backfill 30 --telegram
  code=$?
  printf '[%s] poller exited with code %s; restarting in 5s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$code"
  sleep 5
done
