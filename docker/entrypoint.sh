#!/bin/sh
# Runs the image's commands through the one seller entry point; `start` (the default) runs the seller daemon.
set -eu
cd /app
command=${1:-start}
[ "$#" -gt 0 ] && shift
case "$command" in
  start | setup | tokenizer) exec node --import tsx apps/node/src/bin.ts "$command" "$@" ;;
  gyblos) exec node --import tsx apps/node/src/bin.ts "$@" ;;
  *)
    echo "usage: start | gyblos <args> | setup <args> | tokenizer" >&2
    exit 64
    ;;
esac
