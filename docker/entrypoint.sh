#!/bin/sh
# Maps the image's commands to the node entry points; `start` (the default) runs the seller daemon.
set -eu
cd /app
command=${1:-start}
[ "$#" -gt 0 ] && shift
case "$command" in
  start) exec node --import tsx apps/node/src/main.ts "$@" ;;
  gyblos) exec node --import tsx apps/node/src/cli.ts "$@" ;;
  setup) exec node --import tsx apps/node/src/setup.ts "$@" ;;
  tokenizer) exec node --import tsx apps/node/src/tokenizer.ts "$@" ;;
  *)
    echo "usage: start | gyblos <args> | setup <args> | tokenizer" >&2
    exit 64
    ;;
esac
